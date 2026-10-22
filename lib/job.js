/*
 * lib/job.js - Orkestrasi pipeline utama:
 * URL/file -> download -> audio -> transkripsi (Whisper) -> analisis (Qwen)
 * -> render klip (ffmpeg + subtitle ASS + watermark + musik + SFX)
 */
const fs = require('fs');
const path = require('path');
const video = require('./video');
const subs = require('./subs');
const ai = require('./ai');

function fmtSize(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
}

async function runJob(ctx) {
  const { cfg, bins, modelsDir, isCancelled, registerChild, evt, appVersion } = ctx;
  const tmpRoot = path.join(cfg.outputDir, '.ccp-tmp');
  const t0 = Date.now();

  const STAGES = ['download', 'audio', 'transcribe', 'analyze', 'render'];
  const stageLabel = {
    download: 'Mengunduh video',
    audio: 'Mengekstrak audio',
    transcribe: 'Transkripsi AI (offline)',
    analyze: 'Analisis momen viral (offline)',
    render: 'Merender klip'
  };
  const setStage = (stage, status) => evt('stage', { stage, label: stageLabel[stage] || stage, status });
  const log = (message) => evt('log', { message, time: new Date().toLocaleTimeString('id-ID') });
  const prog = (stage, pct) => evt('progress', { stage, pct: Math.max(0, Math.min(100, pct)) });

  try {
    evt('job-started', {});
    for (const s of STAGES) setStage(s, 'pending');

    // ---- Persiapan folder ----
    fs.mkdirSync(cfg.outputDir, { recursive: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });

    // ---- Inisialisasi AI (cache model) ----
    await ai.init(modelsDir);

    // ---- 1. Sumber video ----
    setStage('download', 'active');
    let sourceFile;
    if (cfg.sourceType === 'url') {
      log('Mengunduh video: ' + cfg.url.slice(0, 90));
      sourceFile = await video.downloadVideo(bins.ytdlp, bins.binDir, cfg.url, tmpRoot, {
        registerChild,
        checkCancel: isCancelled,
        onProgress: (p) => prog('download', p),
        onLog: (l) => { if (!/^\[download\]\s+\d/.test(l)) log(l); }
      });
      log('Video terunduh: ' + path.basename(sourceFile) + ' (' + fmtSize(fs.statSync(sourceFile).size) + ')');
    } else {
      sourceFile = cfg.filePath;
      if (!sourceFile || !fs.existsSync(sourceFile)) throw new Error('File video tidak ditemukan.');
      log('Memakai file lokal: ' + path.basename(sourceFile));
    }
    prog('download', 100);
    setStage('download', 'done');
    if (isCancelled()) throw new Error('DIBATALKAN');

    // ---- 2. Probe durasi + ekstrak audio ----
    setStage('audio', 'active');
    const { duration } = await video.probeDuration(bins.ffprobe, sourceFile);
    log(`Durasi video: ${Math.floor(duration / 60)} menit ${Math.round(duration % 60)} detik`);
    const maxAnalyze = Math.min(duration, (cfg.maxAnalysisMin || 15) * 60);
    const chunks = await video.extractAudioChunks(bins.ffmpeg, sourceFile, path.join(tmpRoot, 'audio'), maxAnalyze, {
      registerChild, checkCancel: isCancelled,
      totalDuration: duration,
      onProgress: (p) => prog('audio', p)
    });
    log(`Audio dipotong jadi ${chunks.length} bagian (60 dtk/bagian).`);
    prog('audio', 100);
    setStage('audio', 'done');
    if (isCancelled()) throw new Error('DIBATALKAN');

    // ---- 3. Transkripsi Whisper (model sesuai pilihan kecepatan user) ----
    setStage('transcribe', 'active');
    const asrModel = cfg.asrModel || 'Xenova/whisper-tiny';
    if (/small/i.test(asrModel)) {
      // Model akurat dimuat di proses terpisah supaya RAM aplikasi utama tetap kecil
      log('Menyiapkan model Whisper Small (proses terpisah, paling akurat)...');
      try {
        await ai.ensureASRReady(asrModel, (p) => {
          if (p.status === 'progress' && p.total) {
            evt('model-progress', { model: p.model, status: p.status, file: p.file, progress: p.progress, loaded: p.loaded, total: p.total });
          }
        });
      } catch (e) {
        log('Catatan: model Small belum siap (' + String(e && e.message || e).slice(0, 70) + '), akan dicoba saat transkripsi.');
      }
    } else {
      await ai.ensureASR(asrModel, (p) => {
        if (p.status === 'progress' && p.total) {
          evt('model-progress', { model: p.model, status: p.status, file: p.file, progress: p.progress, loaded: p.loaded, total: p.total });
        }
      });
    }
    log(`AI mendengarkan & menulis transkrip (${asrModel.includes('small') ? 'mode paling akurat' : 'mode paralel'})...`);
    const words = await ai.transcribeWavChunks(chunks, (done, total) => {
      prog('transcribe', (done / total) * 100);
      log(`Transkripsi bagian ${done}/${total} selesai.`);
    }, { modelId: asrModel, language: cfg.asrLanguage || 'indonesian', registerChild });
    if (!words.length) {
      log('PERINGATAN: Tidak ada ucapan terdeteksi. Klip dibuat merata sepanjang video.');
    } else {
      log(`Transkrip selesai: ${words.length} kata.`);
    }
    setStage('transcribe', 'done');
    if (isCancelled()) throw new Error('DIBATALKAN');

    // ---- 4. Analisis momen viral ----
    setStage('analyze', 'active');
    prog('analyze', 15);
    const targetSec = cfg.clipDuration || 30;
    const maxClips = cfg.clipCount || 3;
    let moments;
    if (words.length) {
      const segments = ai.wordsToSegments(words);
      log(`Transkrip dikelompokkan jadi ${segments.length} segmen.`);
      moments = await ai.analyzeMoments(segments, Math.min(duration, maxAnalyze + 60), targetSec, maxClips, log, { registerChild });
    } else {
      // Tanpa ucapan: bagi merata
      moments = [];
      const usable = Math.min(duration, maxAnalyze);
      const step = usable / (maxClips + 1);
      for (let i = 1; i <= maxClips; i++) {
        const s = Math.floor(step * i);
        moments.push({ start: s, end: Math.min(usable, s + targetSec), title: 'Klip ' + i });
      }
    }
    if (isCancelled()) throw new Error('DIBATALKAN');
    if (!moments.length) throw new Error('Tidak ada momen yang bisa diambil dari video ini.');
    moments.forEach((m, i) => {
      log(`Momen ${i + 1}: ${Math.floor(m.start / 60)}:${String(Math.floor(m.start % 60)).padStart(2, '0')} - "${m.title}"`);
    });
    evt('moments', { moments });
    prog('analyze', 100);
    setStage('analyze', 'done');

    // ---- 5. Render klip ----
    setStage('render', 'active');
    const sfxFile = cfg.hookSfx && bins.assetsDir
      ? path.join(bins.assetsDir, 'sfx_whoosh.wav')
      : null;
    if (sfxFile && !fs.existsSync(sfxFile)) log('Catatan: file SFX tidak ditemukan, dilewati.');

    const clips = [];
    const fontOk = bins.fontsDir && fs.existsSync(bins.fontsDir);
    for (let i = 0; i < moments.length; i++) {
      if (isCancelled()) throw new Error('DIBATALKAN');
      const m = moments[i];
      const base = `klip_${i + 1} - ${video.sanitizeFileName(m.title)}`;
      const outFile = path.join(cfg.outputDir, base + '.mp4');
      const clipTmp = path.join(tmpRoot, `render_${i + 1}`);
      fs.mkdirSync(clipTmp, { recursive: true });

      // Siapkan subtitle (salin font ke folder render agar libass menemukannya)
      let assFile = null;
      const clipWords = words.filter((w) => w.end > m.start && w.start < m.end);
      assFile = subs.writeAss(clipWords, clipTmp, {
        fmt: cfg.format, style: cfg.subtitleStyle, clipStart: m.start, clipEnd: m.end,
        position: cfg.subtitlePosition || 'center'
      });
      if (assFile && fontOk) {
        try {
          for (const f of fs.readdirSync(bins.fontsDir)) {
            fs.copyFileSync(path.join(bins.fontsDir, f), path.join(clipTmp, f));
          }
        } catch (e) {}
      }

      const filterScript = video.buildFilterScript(cfg.format, {
        subsFile: assFile ? 'subs.ass' : null,
        wmInput: cfg.watermarkPath || null,
        musicInput: cfg.musicPath || null,
        sfxInput: sfxFile,
        musicVolume: cfg.musicVolume != null ? cfg.musicVolume : 0.3
      });
      const fcFile = path.join(clipTmp, 'fc.txt');
      fs.writeFileSync(fcFile, filterScript, 'utf8');

      log(`Merender klip ${i + 1}/${moments.length}: "${m.title}"...`);
      await video.renderClip(bins.ffmpeg, sourceFile, outFile, {
        start: m.start, end: m.end,
        cwd: clipTmp,
        filterComplex: filterScript,
        filterScriptFile: 'fc.txt',
        wmInput: cfg.watermarkPath || null,
        musicInput: cfg.musicPath || null,
        sfxInput: (sfxFile && fs.existsSync(sfxFile)) ? sfxFile : null,
        musicVolume: cfg.musicVolume,
        registerChild, checkCancel: isCancelled,
        onProgress: (p) => prog('render', ((i + p / 100) / moments.length) * 100)
      });
      const st = fs.statSync(outFile);
      clips.push({ file: outFile, name: path.basename(outFile), size: st.size, sizeText: fmtSize(st.size) });
      log(`Klip ${i + 1} selesai (${fmtSize(st.size)}).`);
    }
    setStage('render', 'done');
    prog('render', 100);

    // ---- Bersih-bersih ----
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}

    const secs = Math.round((Date.now() - t0) / 1000);
    log(`SELESAI! ${clips.length} klip dibuat dalam ${Math.floor(secs / 60)} mnt ${secs % 60} dtk.`);
    evt('job-done', { clips });
    return { ok: true, clips };
  } catch (err) {
    const msg = String(err && err.message || err);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) {}
    evt('job-error', { message: msg });
    return { ok: false, error: msg };
  }
}

module.exports = { runJob };
