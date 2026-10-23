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

/* ---------------- Efek cinematik (v1.5.0) ---------------- */
function resForEffect(fmt) {
  if (fmt === 'square') return '1080x1080';
  if (fmt === 'original') return '1280x720';
  return '1080x1920';
}

function effectChainParts(inLabel, effect, fmt, clipDur) {
  if (!effect || effect === 'none') return { parts: [], out: inLabel };
  const barH = 'ih*0.085';
  const bars = `drawbox=x=0:y=0:w=iw:h=${barH}:color=black:t=fill,drawbox=x=0:y=ih-${barH}:w=iw:h=${barH}:color=black:t=fill`;
  const parts = [];
  switch (effect) {
    case 'classic':
      parts.push(`[${inLabel}]eq=contrast=1.05:saturation=1.12,colorbalance=rs=0.06:bs=0.10:rm=0.04:bh=-0.06,${bars}[ce]`);
      return { parts, out: 'ce' };
    case 'dramatis':
      parts.push(`[${inLabel}]eq=contrast=1.15:saturation=1.05:brightness=-0.02,vignette=PI/4.5,noise=alls=6:allf=t+u[ce]`);
      return { parts, out: 'ce' };
    case 'vintage':
      parts.push(`[${inLabel}]eq=contrast=0.95:saturation=0.72:gamma=1.05,colorbalance=rs=0.10:rm=0.05:bs=-0.05,noise=alls=8:allf=t+u[ce]`);
      return { parts, out: 'ce' };
    case 'mono':
      parts.push(`[${inLabel}]hue=s=0,eq=contrast=1.12:brightness=-0.01,${bars}[ce]`);
      return { parts, out: 'ce' };
    case 'zoom': {
      // fps=30 dulu supaya kecepatan zoom konsisten di sumber fps berapa pun
      const dur = Math.max(1, Number(clipDur) || 30);
      const rate = (0.14 / (dur * 30)).toFixed(8);
      let prep = '';
      if (fmt === 'original') {
        // ukuran asli bervariasi -> normalisasi dulu ke 1280x720
        prep = 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,';
      }
      parts.push(
        `[${inLabel}]fps=30,${prep}zoompan=z='min(1.14,zoom+${rate})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${resForEffect(fmt)}:fps=30[ce]`
      );
      return { parts, out: 'ce' };
    }
    default:
      return { parts, out: inLabel };
  }
}

/* ---------------- FACE TRACKING: ekspresi crop dinamis (v1.6.0) ---------------- */
/*
 * points: [{t, cx}] — pusat orang (koordinat piksel SOURCE) pada waktu t
 *         (t relatif awal klip; sudah dihaluskan EMA di lib/face.js)
 * Menghasilkan ekspresi x untuk filter crop ffmpeg: interpolasi linear
 * antar titik, di-clamp ke [0, iw-ow] supaya crop tidak keluar frame.
 * Semua simbolik (iw/ih/ow) jadi tak perlu tahu resolusi sumber di sini.
 */
function decimatePoints(points, minStep = 0.8) {
  if (!points || points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    if (points[i].t - out[out.length - 1].t >= minStep) out.push(points[i]);
  }
  out.push(points[points.length - 1]);
  return out;
}

function cropXExpr(points, centerOffsetExpr) {
  const pts = decimatePoints(points, 0.8);
  const f = (v) => String(Math.round(v * 1000) / 1000);
  const xa = (cx) => `(${f(cx)}-(${centerOffsetExpr}))`;
  let inner = xa(pts[pts.length - 1].cx);
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i - 1], b = pts[i];
    const slope = (b.cx - a.cx) / Math.max(1e-6, b.t - a.t);
    inner = `if(lt(t,${f(b.t)}),${xa(a.cx)}+${f(slope)}*(t-${f(a.t)}),${inner})`;
  }
  return `clip(${inner},0,iw-ow)`;
}

/* v1.7.0: ekspresi crop STEP (cut langsung) — posisi konstan di tiap
 * segmen, pindah INSTAN di titik t pergantian pembicara (tanpa pan).
 * Default (t < pergantian pertama) = posisi titik PERTAMA. */
function cropXExprSnap(points, centerOffsetExpr) {
  const f = (v) => String(Math.round(v * 1000) / 1000);
  const xa = (cx) => `(${f(cx)}-(${centerOffsetExpr}))`;
  let inner = xa(points[0].cx);
  for (let i = points.length - 1; i > 0; i--) {
    inner = `if(gte(t,${f(points[i].t)}),${xa(points[i].cx)},${inner})`;
  }
  return `clip(${inner},0,iw-ow)`;
}

/* filter crop utk 1 format; faceTrack = { points:[{t,cx}], snap } atau null
 * vSrc: label sumber video ('0:v' atau 'c0' bila letterbox pre-crop aktif) */
function cropFilterFor(fmt, faceTrack, vSrc) {
  vSrc = vSrc || '0:v';
  if (fmt === 'full916') {
    if (faceTrack && faceTrack.points && faceTrack.points.length >= 2) {
      const ex = faceTrack.snap
        ? cropXExprSnap(faceTrack.points, 'ih*9/32')
        : cropXExpr(faceTrack.points, 'ih*9/32');
      return `[${vSrc}]crop=ih*9/16:ih:'${ex}',scale=1080:1920,setsar=1[b0]`;
    }
    return `[${vSrc}]crop=ih*9/16:ih,scale=1080:1920,setsar=1[b0]`;
  }
  if (fmt === 'square') {
    if (faceTrack && faceTrack.points && faceTrack.points.length >= 2) {
      const ex = faceTrack.snap
        ? cropXExprSnap(faceTrack.points, 'min(iw,ih)/2')
        : cropXExpr(faceTrack.points, 'min(iw,ih)/2');
      return `[${vSrc}]crop='min(iw,ih)':'min(iw,ih)':'${ex}',scale=1080:1080,setsar=1[b0]`;
    }
    return `[${vSrc}]crop='min(iw,ih)':'min(iw,ih)',scale=1080:1080,setsar=1[b0]`;
  }
  return null;
}

/* ---------------- v1.7.0: DETEKSI BAR HITAM (letterbox) ----------------
 * Banyak video YouTube memuat bar hitam bawaan di dalam frame-nya sendiri,
 * sehingga hasil crop 9:16 masih tampak garis hitam atas/bawah. Kita
 * deteksi area konten memakai filter cropdetect pada ±40 frame sampel,
 * ambil nilai median, lalu potong dulu sebelum crop face tracking. */
async function detectLetterbox(ffmpeg, sourceFile, duration, srcW, srcH) {
  if (!srcW || !srcH || srcW < 2 || srcH < 2) return null;
  try {
    const t0 = Math.min(Math.max(0, duration * 0.08), 30);
    const { stderr } = await run(ffmpeg, [
      '-y', '-nostdin',
      '-ss', t0.toFixed(2), '-t', '20',
      '-i', sourceFile,
      '-vf', 'fps=2,cropdetect=limit=24:round=2',
      '-f', 'null', '-'
    ]);
    const re = /crop=(\d+):(\d+):(\d+):(\d+)/g;
    const vals = [];
    let m;
    while ((m = re.exec(stderr)) !== null) vals.push([+m[1], +m[2], +m[3], +m[4]]);
    if (vals.length < 6) return null;
    const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    const w = med(vals.map((v) => v[0])), h = med(vals.map((v) => v[1]));
    const x = med(vals.map((v) => v[2])), y = med(vals.map((v) => v[3]));
    if (w >= srcW * 0.985 && h >= srcH * 0.985) return null; // tidak ada letterbox berarti
    if (w < srcW * 0.5 || h < srcH * 0.5) return null;       // deteksi tidak masuk akal (video gelap?) → abaikan
    if (w === srcW && h === srcH) return null;
    return { w, h, x, y };
  } catch (e) {
    return null; // gagal deteksi → jangan potong (fallback aman)
  }
}

/* ---------------- Bangun filter grafik untuk 1 klip ---------------- */
function buildFilterScript(fmt, opts) {
  // fmt: 'full916' | 'blur916' | 'square' | 'original'
  const hasSubs = !!opts.subsFile;
  const hasWm = !!opts.wmInput;
  const hasMusic = !!opts.musicInput;
  const hasSfx = !!opts.sfxInput;
  const parts = [];

  // v1.7.0: pre-crop bar hitam (letterbox) bila terdeteksi di video sumber
  let vSrc = '0:v';
  if (opts.letterboxCrop && opts.letterboxCrop.w > 0 && opts.letterboxCrop.h > 0) {
    const lb = opts.letterboxCrop;
    parts.push(`[0:v]crop=${lb.w}:${lb.h}:${lb.x}:${lb.y}[c0]`);
    vSrc = 'c0';
  }

  // Index input: 0=video, lalu berurutan: watermark, musik, sfx
  const vIdx = 0;
  let cur = 1;
  const wmIdx = hasWm ? cur++ : -1;
  const musicIdx = hasMusic ? cur++ : -1;
  const sfxIdx = hasSfx ? cur++ : -1;

  let base;
  if (fmt === 'full916') {
    base = cropFilterFor('full916', opts.faceTrack, vSrc);
  } else if (fmt === 'blur916') {
    parts.push(
      `[${vSrc}]split=2[bgsrc][fgsrc]`,
      `[bgsrc]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=luma_radius=24:luma_power=2[bg]`,
      `[fgsrc]scale=1080:-2[fg]`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2[b${vIdx}]`
    );
    base = null;
  } else if (fmt === 'square') {
    base = cropFilterFor('square', opts.faceTrack, vSrc);
  } else {
    base = `[${vSrc}]scale=1280:-2,setsar=1[b${vIdx}]`;
  }
  if (base) parts.push(base);

  // Efek cinematik diterapkan pada hasil format, sebelum watermark & subtitle
  const eff = effectChainParts(`b${vIdx}`, opts.effect, fmt, opts.clipDur);
  parts.push(...eff.parts);

  let vOut = eff.out;
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

  // Audio — v1.6.0: musik di-loop bila lebih pendek, fade in/out,
  // dan AUTO-DUCK (musik mengecil otomatis saat ada yang bicara)
  const DUR = Math.max(1, Number(opts.clipDur) || 30);
  const aParts = [];
  if (hasMusic && opts.musicDuck) {
    aParts.push(`[0:a]asplit=2[av][asc]`); // saluran suara + sidechain
  } else {
    aParts.push(`[0:a]anull[av]`);
  }
  if (hasMusic) {
    const vol = (opts.musicVolume != null ? opts.musicVolume : 0.3).toFixed(2);
    const fadeOutStart = Math.max(0.5, DUR - 1.6).toFixed(3);
    aParts.push(
      `[${musicIdx}:a]volume=${vol},aloop=loop=-1:size=2000000000,atrim=0:${DUR.toFixed(3)},afade=t=in:st=0:d=0.8,afade=t=out:st=${fadeOutStart}:d=1.5[am]`
    );
    if (opts.musicDuck) {
      // input 1 = musik (dikompres), input 2 = suara (sidechain pemicu)
      aParts.push(`[am][asc]sidechaincompress=threshold=0.015:ratio=10:attack=30:release=450[aduck]`);
    } else {
      aParts.push(`[am]anull[aduck]`);
    }
    if (hasSfx) {
      aParts.push(`[${sfxIdx}:a]adelay=120:all=1,volume=1.3[sfx]`);
      aParts.push(`[av][aduck][sfx]amix=inputs=3:duration=first:normalize=0[aout]`);
    } else {
      aParts.push(`[av][aduck]amix=inputs=2:duration=first:normalize=0[aout]`);
    }
  } else if (hasSfx) {
    aParts.push(`[${sfxIdx}:a]adelay=120:all=1,volume=1.3[sfx]`);
    aParts.push(`[av][sfx]amix=inputs=2:duration=first:normalize=0,volume=1.4[aout]`);
  } else {
    aParts.push(`[av]anull[aout]`);
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
  cropXExpr,
  cropXExprSnap,
  detectLetterbox,
  decimatePoints,
  renderClip,
  sanitizeFileName
};
