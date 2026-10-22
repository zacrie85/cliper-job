/*
 * lib/video.js - Operasi video: yt-dlp download, ffprobe, ffmpeg cut/crop/render
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd || undefined,
      windowsHide: true
    });
    if (opts.registerChild) opts.registerChild(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      if (opts.onStdout) opts.onStdout(s);
      if (stdout.length > 400000) stdout = stdout.slice(-200000);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (opts.onStderr) opts.onStderr(s);
      if (stderr.length > 400000) stderr = stderr.slice(-200000);
    });
    child.on('error', (err) => reject(new Error('Gagal menjalankan: ' + cmd + ' -> ' + err.message)));
    child.on('close', (code) => {
      if (opts.checkCancel && opts.checkCancel()) return reject(new Error('DIBATALKAN'));
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(String(cmd))} keluar dengan kode ${code}. ${stderr.slice(-600)}`));
    });
  });
}

/* ---------------- ffprobe ---------------- */
async function probeDuration(ffprobe, file) {
  const { stdout } = await run(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file
  ]);
  const info = JSON.parse(stdout);
  let dur = 0;
  if (info.format && info.format.duration) dur = parseFloat(info.format.duration);
  if (!dur && info.streams) {
    for (const s of info.streams) if (s.duration) { dur = Math.max(dur, parseFloat(s.duration)); }
  }
  return { duration: dur, info };
}

/* ---------------- yt-dlp download ---------------- */
function parseYtdlpProgress(line, cb) {
  const m = line.match(/\[download\]\s+(\d{1,3}(?:\.\d+)?)%/);
  if (m) cb(parseFloat(m[1]));
}

async function downloadVideo(ytdlp, binDir, url, outDir, opts = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const outTmpl = path.join(outDir, 'source.%(ext)s');
  const args = [
    '--ffmpeg-location', binDir === '.' ? path.dirname(ytdlp) : binDir,
    '--no-playlist',
    '--newline',
    '--no-part',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', outTmpl,
    url
  ];
  let buf = '';
  await run(ytdlp, args, {
    registerChild: opts.registerChild,
    checkCancel: opts.checkCancel,
    onStdout: (s) => {
      buf += s;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const ln of lines) {
        if (opts.onLog && ln.trim()) opts.onLog(ln.trim());
        parseYtdlpProgress(ln, (p) => opts.onProgress && opts.onProgress(p));
      }
    },
    onStderr: (s) => {
      buf += s;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const ln of lines) {
        if (opts.onLog && ln.trim()) opts.onLog('[yt-dlp] ' + ln.trim());
      }
    }
  });
  // Cari file hasil
  const files = fs.readdirSync(outDir).filter((f) => f.startsWith('source.'));
  if (!files.length) throw new Error('Download selesai tetapi file video tidak ditemukan.');
  files.sort((a, b) => fs.statSync(path.join(outDir, b)).size - fs.statSync(path.join(outDir, a)).size);
  return path.join(outDir, files[0]);
}

/* ---------------- Ekstrak audio WAV 16k mono per chunk 60 dtk ---------------- */
async function extractAudioChunks(ffmpeg, videoFile, tmpDir, maxSeconds, opts = {}) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPattern = path.join(tmpDir, 'chunk_%03d.wav');
  const args = [
    '-y', '-nostdin',
    '-i', videoFile,
    '-t', String(Math.max(60, Math.floor(maxSeconds))),
    '-vn', '-ac', '1', '-ar', '16000', '-acodec', 'pcm_s16le',
    '-f', 'segment', '-segment_time', '60', '-reset_timestamps', '1',
    '-progress', 'pipe:1', '-nostats',
    outPattern
  ];
  await run(ffmpeg, args, {
    registerChild: opts.registerChild,
    checkCancel: opts.checkCancel,
    onStdout: (s) => {
      const m = s.match(/out_time_us=(\d+)/);
      if (m && opts.totalDuration && opts.onProgress) {
        const pct = Math.min(99, (parseFloat(m[1]) / 1e6 / Math.min(opts.totalDuration, maxSeconds)) * 100);
        opts.onProgress(pct);
      }
    }
  });
  const chunks = fs.readdirSync(tmpDir).filter((f) => /^chunk_\d+\.wav$/.test(f)).sort();
  if (!chunks.length) throw new Error('Gagal mengekstrak audio dari video.');
  return chunks.map((f) => path.join(tmpDir, f));
}

/* ---------------- Bangun filter grafik untuk 1 klip ---------------- */
function buildFilterScript(fmt, opts) {
  // fmt: 'full916' | 'blur916' | 'square' | 'original'
  const hasSubs = !!opts.subsFile;
  const hasWm = !!opts.wmInput;
  const hasMusic = !!opts.musicInput;
  const hasSfx = !!opts.sfxInput;
  const parts = [];

  // Index input: 0=video, lalu berurutan: watermark, musik, sfx
  const vIdx = 0;
  let cur = 1;
  const wmIdx = hasWm ? cur++ : -1;
  const musicIdx = hasMusic ? cur++ : -1;
  const sfxIdx = hasSfx ? cur++ : -1;

  let base;
  if (fmt === 'full916') {
    base = `[0:v]crop=ih*9/16:ih,scale=1080:1920,setsar=1[b${vIdx}]`;
  } else if (fmt === 'blur916') {
    parts.push(
      `[0:v]split=2[bgsrc][fgsrc]`,
      `[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=24:luma_power=2[bg]`,
      `[fgsrc]scale=1080:-2[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[b${vIdx}]`
    );
    base = null;
  } else if (fmt === 'square') {
    base = `[0:v]crop='min(iw,ih)':'min(iw,ih)',scale=1080:1080,setsar=1[b${vIdx}]`;
  } else {
    base = `[0:v]scale=1280:-2,setsar=1[b${vIdx}]`;
  }
  if (base) parts.push(base);

  let vOut = `b${vIdx}`;
  if (hasWm) {
    parts.push(
      `[${wmIdx}:v]scale=iw*0.16:-1,format=rgba,colorchannelmixer=aa=0.9[wm]`,
      `[${vOut}][wm]overlay=W-w-40:40:shortest=1[vw]`
    );
    vOut = 'vw';
  }
  if (hasSubs) {
    parts.push(`[${vOut}]ass=${opts.subsFile}:fontsdir=.[vs]`);
    vOut = 'vs';
  }
  parts.push(`[${vOut}]null[vout]`);

  // Audio
  let aOut = '[aout]';
  const aParts = [];
  aParts.push(`[0:a]volume=1.0[a0]`);
  if (hasMusic) {
    const vol = (opts.musicVolume != null ? opts.musicVolume : 0.3).toFixed(2);
    aParts.push(`[${musicIdx}:a]volume=${vol}[am]`);
    if (hasSfx) {
      aParts.push(`[${sfxIdx}:a]adelay=120:all=1,volume=1.3[sfx]`);
      aParts.push(`[a0][am][sfx]amix=inputs=3:duration=first,volume=2.2[aout]`);
    } else {
      aParts.push(`[a0][am]amix=inputs=2:duration=first,volume=1.8[aout]`);
    }
  } else if (hasSfx) {
    aParts.push(`[${sfxIdx}:a]adelay=120:all=1,volume=1.3[sfx]`);
    aParts.push(`[a0][sfx]amix=inputs=2:duration=first,volume=1.7[aout]`);
  } else {
    aParts.push(`[a0]anull[aout]`);
  }
  parts.push(...aParts);

  return parts.join(';\n');
}

/* ---------------- Render 1 klip ---------------- */
/*
 * Opsi untuk memasukkan filter graph berbeda antar versi ffmpeg:
 *  - ffmpeg lama (< 8): -filter_complex_script <file>
 *  - ffmpeg baru (>= 7 punya, >= 8 WAJIB): -/filter_complex <file>  (opsi lama DIHAPUS di ffmpeg 8+)
 *  - paling universal: -filter_complex <isi langsung> (semua versi)
 * Karena itu dicoba bertahap sampai ketemu mode yang didukung, lalu di-cache.
 */
let _fcMode = null;

function isOptionError(msg) {
  return /Unrecognized option|Option not found|Error splitting the argument list|Unknown option/i.test(String(msg || ''));
}

async function renderClip(ffmpeg, videoFile, outFile, opts) {
  const dur = (opts.end - opts.start);
  const args = ['-y', '-nostdin', '-ss', String(opts.start), '-i', videoFile];
  if (opts.wmInput) {
    args.push('-loop', '1', '-i', opts.wmInput);
  }
  if (opts.musicInput) args.push('-i', opts.musicInput);
  if (opts.sfxInput) args.push('-i', opts.sfxInput);
  args.push('-t', dur.toFixed(3));
  args.push('-map', '[vout]', '-map', '[aout]');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
  args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '44100');
  args.push('-movflags', '+faststart');
  args.push('-progress', 'pipe:1', '-nostats');
  args.push(outFile);

  const content = String(opts.filterComplex || '').replace(/\r?\n/g, '');
  const modes = _fcMode ? [_fcMode] : ['direct', 'slash', 'script'];
  let lastErr = null;
  for (let mi = 0; mi < modes.length; mi++) {
    const mode = modes[mi];
    const a = args.slice();
    const mapIdx = a.indexOf('-map');
    if (mode === 'direct') a.splice(mapIdx, 0, '-filter_complex', content);
    else if (mode === 'slash') a.splice(mapIdx, 0, '-/filter_complex', opts.filterScriptFile);
    else a.splice(mapIdx, 0, '-filter_complex_script', opts.filterScriptFile);
    try {
      await run(ffmpeg, a, {
        cwd: opts.cwd, // berisi fc.txt, subs.ass, font
        registerChild: opts.registerChild,
        checkCancel: opts.checkCancel,
        onStdout: (s) => {
          const m = s.match(/out_time_us=(\d+)/);
          if (m && opts.onProgress) {
            const pct = Math.min(99, (parseFloat(m[1]) / 1e6 / dur) * 100);
            opts.onProgress(pct);
          }
        }
      });
      _fcMode = mode;
      return outFile;
    } catch (err) {
      lastErr = err;
      // Coba mode berikutnya HANYA jika masalahnya opsi tidak dikenal
      if (isOptionError(err.message) && mi < modes.length - 1) continue;
      throw err;
    }
  }
  throw lastErr;
}

function sanitizeFileName(s, maxLen = 32) {
  const clean = String(s)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (clean || 'klip-viral').slice(0, maxLen);
}

module.exports = {
  run,
  probeDuration,
  downloadVideo,
  extractAudioChunks,
  buildFilterScript,
  renderClip,
  sanitizeFileName
};
