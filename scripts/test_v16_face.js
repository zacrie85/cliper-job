/*
 * test_v16_face.js — Uji FACE TRACKING v1.6.0
 * 1. Bangun video simulasi podcast 1920x1080: orang pindah kanan→kiri pada t=30s
 * 2. Jalankan face.buildTracks → lintasan harus mengikuti (cx kanan → cx kiri)
 * 3. Deteksi juga video asli user (vertikal, 2 pembicara)
 */
const path = require('path');
const fs = require('fs');
const video = require('../lib/video');
const face = require('../lib/face');

const UPLOAD = '/home/z/my-project/upload/WhatsApp Video 2026-10-23 at 09.32.32.mp4';
const TMP = '/tmp/klip_v16_test';
const OUT = path.join(TMP, 'simulasi_podcast.mp4');
const MODELS_DIR = path.join(TMP, 'models');

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(MODELS_DIR, { recursive: true });
  const ai = require('../lib/ai');
  await ai.init(MODELS_DIR);

  // ---- 1. bangun simulasi: 1920x1080, orang kanan (0-30s) lalu kiri (30-60s) ----
  console.log('== Membangun video simulasi podcast ==');
  await video.run('ffmpeg', [
    '-y', '-nostdin',
    '-t', '60', '-i', UPLOAD,
    '-filter_complex',
    "color=black:s=1920x1080:d=60:r=30[bg];[0:v]scale=1080:1920,setsar=1,fps=30[fg];[bg][fg]overlay=x='if(lt(t,30),840,0)':y=0",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '128k', '-shortest', OUT
  ]);
  const { info } = await video.probeDuration('ffprobe', OUT);
  const vs = (info.streams || []).find((s) => s.width);
  console.log('Simulasi jadi:', OUT, vs.width + 'x' + vs.height);

  // ---- 2. face tracking 2 segmen ----
  console.log('\n== Face tracking (YOLOS-tiny, pertama kali download model ~27MB) ==');
  const bins = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', binDir: '.', assetsDir: path.join(__dirname, '..', 'assets'), fontsDir: null };
  const moments = [
    { start: 2, end: 26, title: 'orang di kanan' },
    { start: 34, end: 58, title: 'orang di kiri' }
  ];
  const t0 = Date.now();
  const tracks = await face.buildTracks(bins, moments, OUT, path.join(TMP, 'work'), MODELS_DIR, {
    meta: { width: 1920, height: 1080 },
    log: (m) => console.log('[log]', m),
    onProgress: (p) => console.log('[progress]', Math.round(p * 100) + '%')
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`Selesai dalam ${secs}s — tracks: ${tracks.size}/${moments.length}`);

  let pass = true;
  const check = (idx, expectCx, label) => {
    const tr = tracks.get(idx);
    if (!tr) { console.log(`❌ ${label}: tidak ada track`); pass = false; return; }
    const mid = tr.points[Math.floor(tr.points.length / 2)];
    const avg = tr.points.reduce((s, p) => s + p.cx, 0) / tr.points.length;
    console.log(`${label}: cx tengah=${mid.cx.toFixed(0)} rata2=${avg.toFixed(0)} (harus dekat ${expectCx})`);
    if (Math.abs(avg - expectCx) > 260) { console.log(`❌ ${label} meleset`); pass = false; }
    else console.log(`✅ ${label} benar`);
  };
  check(0, 1380, 'Klip 1 (orang kanan)');
  check(1, 540, 'Klip 2 (orang kiri)');

  // ---- 3. deteksi video asli user (2 pembicara) ----
  console.log('\n== Face tracking video asli user (podcast 2 orang) ==');
  const t2 = Date.now();
  const tracks2 = await face.buildTracks(bins, [{ start: 3, end: 40, title: 'user podcast' }], UPLOAD, path.join(TMP, 'work2'), MODELS_DIR, {
    meta: { width: 1080, height: 1920 },
    log: (m) => console.log('[log]', m),
    onProgress: (p) => console.log('[progress]', Math.round(p * 100) + '%')
  });
  console.log(`Waktu: ${((Date.now() - t2) / 1000).toFixed(1)}s`);
  const tr2 = tracks2.get(0);
  if (tr2) {
    const xs = tr2.points.map((p) => p.cx);
    const min = Math.min(...xs), max = Math.max(...xs);
    console.log(`Track user: ${tr2.points.length} titik, cx ${min.toFixed(0)}..${max.toFixed(0)} (gerak ${max - min > 120 ? 'BANYAK — pembicara berganti ✅' : 'sedikit — satu pembicara dominan'})`);
  } else {
    console.log('⚠️ Video user: tidak ada track (mungkin orang kecil di frame)');
  }

  console.log(pass ? '\nFACE TRACK TEST PASSED ✅' : '\nFACE TRACK TEST GAGAL ❌');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
