/*
 * lib/job.js - Orkestrasi pipeline utama:
 * URL/file -> download -> audio -> transkripsi (Whisper) -> analisis (Qwen)
 * -> deteksi pembicara (YOLOS face tracking, v1.6.0)
 * -> render klip PARALEL (ffmpeg + subtitle ASS + watermark + musik auto-duck + SFX)
 */
const fs = require('fs');
const path = require('path');
const video = require('./video');
const subs = require('./subs');
const ai = require('./ai');
const face = require('./face');

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

  const STAGES = ['download', 'audio', 'transcribe', 'analyze', 'detect', 'render'];
  const stageLabel = {
    download: 'Mengunduh video',
    audio: 'Mengekstrak audio',
    transcribe: 'Transkripsi AI (offline)',
    analyze: 'Analisis momen viral (offline)',
    detect: 'Face tracking — kunci pembicara (offline)',
    render: 'Merender klip (paralel)'
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

    // ---- 2. Probe durasi + resolusi + ekstrak audio ----
    setStage('audio', 'active');
    const { duration, info } = await video.probeDuration(bins.ffprobe, sourceFile);
    let vw = 0, vh = 0;
    try {
      const vs = (info.streams || []).find((s) => s.width && s.height);
      if (vs) { vw = vs.width; vh = vs.height; }
    } catch (e) {}
    log(`Durasi video: ${Math.floor(duration / 60)} menit ${Math.round(duration % 60)} detik` + (vw ? ` (${vw}x${vh})` : ''));

    // ---- v1.7.0: potong bar hitam (letterbox) bawaan video sumber ----
    let letterboxCrop = null;
    try {
      letterboxCrop = await video.detectLetterbox(bins.ffmpeg, sourceFile, duration, vw, vh);
      if (letterboxCrop) {
        vw = letterboxCrop.w; vh = letterboxCrop.h;
        log(`Bar hitam terdeteksi di video sumber — otomatis dipotong agar hasil FULL ${vw}x${vh} (tanpa area hitam).`);
      }
    } catch (e) { letterboxCrop = null; }

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
      // Tanpa ucapan: satu klip per jendela waktu (jumlah tetap sesuai pilihan)
      const plan = ai.planWindows(Math.min(duration, maxAnalyze), maxClips, targetSec);
      if (plan.note) log(plan.note);
      moments = [];
      const usable = Math.min(duration, maxAnalyze);
      for (let i = 0; i < plan.windows.length; i++) {
        const w = plan.windows[i];
        const len = w.we - w.ws;
        const s = w.ws + Math.max(0, (len - plan.target) / 2);
        const e = Math.min(usable, s + plan.target);
        if (e - s >= 5) moments.push({ start: Math.floor(s), end: Math.floor(e), title: 'Klip ' + (i + 1) });
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

    // ---- 5. FACE TRACKING (v1.6.0): kunci posisi pembicara per klip ----
    const wantFace = cfg.faceTrack !== false && (cfg.format === 'full916' || cfg.format === 'square');
    let faceTracks = new Map();
    if (wantFace) {
      setStage('detect', 'active');
      const camMode = cfg.cameraMotion === 'smooth' ? 'smooth' : 'snap';
      log(camMode === 'snap'
        ? 'Pergerakan kamera: CUT LANGSUNG (crop pindah instan ke pembicara baru).'
        : 'Pergerakan kamera: HALUS (crop bergeser perlahan mengikuti pembicara).');
      try {
        faceTracks = await face.buildTracks(bins, moments, sourceFile, tmpRoot, modelsDir, {
          evt,
          log,
          meta: { width: vw, height: vh },
          mode: camMode,
          fmt: cfg.format,
          onProgress: (p) => prog('detect', p * 100)
        });
        if (faceTracks.size) {
          log(`Face tracking aktif pada ${faceTracks.size}/${moments.length} klip — hasil crop otomatis mengikuti pembicara.`);
        } else {
          log('Face tracking: pembicara tidak terdeteksi — semua klip memakai crop tengah.');
        }
      } catch (e) {
        log('Face tracking dilewati (' + String(e && e.message || e).slice(0, 80) + ').');
      }
      prog('detect', 100);
      setStage('detect', 'done');
      if (isCancelled()) throw new Error('DIBATALKAN');
    } else {
      setStage('detect', 'done');
      prog('detect', 100);
    }

    // ---- 6. Render klip (PARALEL, 2 ffmpeg sekaligus — v1.6.0) ----
    setStage('render', 'active');
    const sfxFile = cfg.hookSfx && bins.assetsDir
      ? path.join(bins.assetsDir, 'sfx_whoosh.wav')
      : null;
    if (sfxFile && !fs.existsSync(sfxFile)) log('Catatan: file SFX tidak ditemukan, dilewati.');

    // Musik latar dari pustaka bawaan (v1.6.0)
    let musicFile = null;
    if (cfg.musicSource === 'builtin' && cfg.musicTrack) {
      const cand = path.join(bins.assetsDir, 'music', cfg.musicTrack + '.mp3');
      if (fs.existsSync(cand)) musicFile = cand;
      else log('Catatan: musik pustaka tidak ditemukan, dilewati.');
    } else if (cfg.musicSource === 'custom' && cfg.musicPath) {
      musicFile = cfg.musicPath;
    }

    const fontOk = bins.fontsDir && fs.existsSync(bins.fontsDir);

    // ---- v1.7.0: caption/judul video + hindari tabrakan posisi dgn subtitle ----
    const captionOn = !!(cfg.captionText && String(cfg.captionText).trim());
    let subPos = cfg.subtitlePosition || 'center';
    if (captionOn && (cfg.captionPosition || 'center') === subPos) {
      subPos = subPos === 'bottom' ? 'center' : 'bottom';
      log('Catatan: caption & subtitle di posisi sama — subtitle otomatis digeser ke ' + (subPos === 'bottom' ? 'bawah' : 'tengah') + ' agar tidak bertabrakan.');
    }
    if (captionOn) log('Caption dipakai: "' + String(cfg.captionText).trim().slice(0, 60) + '" (' + (cfg.captionPosition || 'center') + ').');

    const renderTasks = moments.map((m, i) => ({ m, i }));
    const clips = [];
    const progMap = new Map(); // taskIndex -> pct 0..100 klip tersebut
    const bump = (i, pct) => {
      progMap.set(i, pct);
      let sum = 0;
      for (let k = 0; k < moments.length; k++) sum += (progMap.get(k) || 0);
      prog('render', sum / moments.length);
    };

    const prepareClip = (m, i) => {
      const base = `klip_${i + 1} - ${video.sanitizeFileName(m.title)}`;
      const outFile = path.join(cfg.outputDir, base + '.mp4');
      const clipTmp = path.join(tmpRoot, `render_${i + 1}`);
      fs.mkdirSync(clipTmp, { recursive: true });

      // Siapkan subtitle (salin font ke folder render agar libass menemukannya)
      const clipWords = words.filter((w) => w.end > m.start && w.start < m.end);
      const assFile = subs.writeAss(clipWords, clipTmp, {
        fmt: cfg.format, style: cfg.subtitleStyle, clipStart: m.start, clipEnd: m.end,
        position: subPos,
        color: cfg.subtitleColor || null,
        font: cfg.subtitleFont || 'poppins',
        size: cfg.subtitleSize || 'normal',
        outline: cfg.subtitleOutline || 'normal',
        caption: captionOn ? { text: cfg.captionText, position: cfg.captionPosition || 'center' } : null
      });
      if (assFile && fontOk) {
        try {
          for (const f of fs.readdirSync(bins.fontsDir)) {
            fs.copyFileSync(path.join(bins.fontsDir, f), path.join(clipTmp, f));
          }
        } catch (e) {}
      }

      const track = faceTracks.get(i) || null;
      if (track && track.points) {
        // shift waktu: titik track relatif awal klip -> -ss sudah reset t ke 0
        track.points = track.points.map((p) => ({ t: p.t, cx: p.cx, cy: p.cy }));
      }
      const filterScript = video.buildFilterScript(cfg.format, {
        subsFile: assFile ? 'subs.ass' : null,
        wmInput: cfg.watermarkPath || null,
        musicInput: musicFile,
        sfxInput: (sfxFile && fs.existsSync(sfxFile)) ? sfxFile : null,
        musicVolume: cfg.musicVolume != null ? cfg.musicVolume : 0.3,
        musicDuck: cfg.musicDuck !== false,
        effect: cfg.cinematicEffect || 'none',
        clipDur: m.end - m.start,
        faceTrack: track,
        letterboxCrop: letterboxCrop
      });
      const fcFile = path.join(clipTmp, 'fc.txt');
      fs.writeFileSync(fcFile, filterScript, 'utf8');
      return { outFile, clipTmp, filterScript, title: m.title };
    };

    const renderOne = async (m, i) => {
      const prepared = prepareClip(m, i);
      log(`Merender klip ${i + 1}/${moments.length}: "${m.title}"...`);
      await video.renderClip(bins.ffmpeg, sourceFile, prepared.outFile, {
        start: m.start, end: m.end,
        cwd: prepared.clipTmp,
        filterComplex: prepared.filterScript,
        filterScriptFile: 'fc.txt',
        wmInput: cfg.watermarkPath || null,
        musicInput: musicFile,
        sfxInput: (sfxFile && fs.existsSync(sfxFile)) ? sfxFile : null,
        musicVolume: cfg.musicVolume,
        registerChild, checkCancel: isCancelled,
        onProgress: (p) => bump(i, p)
      });
      const st = fs.statSync(prepared.outFile);
      clips.push({ file: prepared.outFile, name: path.basename(prepared.outFile), size: st.size, sizeText: fmtSize(st.size), idx: i });
      log(`Klip ${i + 1} selesai (${fmtSize(st.size)}).`);
      try { fs.rmSync(prepared.clipTmp, { recursive: true, force: true }); } catch (e) {}
    };

    // Pool paralel: 2 render bersamaan (aman utk RAM & CPU kebanyakan PC)
    const POOL = Math.min(2, renderTasks.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < renderTasks.length) {
        if (isCancelled()) throw new Error('DIBATALKAN');
        const t = renderTasks[cursor++];
        await renderOne(t.m, t.i);
      }
    };
    await Promise.all(Array.from({ length: POOL }, () => worker()));

    clips.sort((a, b) => a.idx - b.idx);
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
