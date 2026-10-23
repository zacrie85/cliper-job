/*
 * test_v17.js — Uji 3 fitur v1.7.0:
 *  1. CUT LANGSUNG (snap): crop diam lalu pindah instan saat pembicara berganti
 *  2. CAPTION/JUDUL: teks tetap sepanjang klip + posisi atas/tengah/bawah
 *  3. AUTO-TRIM BAR HITAM: letterbox terdeteksi & hasil render full 9:16
 */
const path = require('path');
const fs = require('fs');
const video = require('../lib/video');
const subs = require('../lib/subs');
const face = require('../lib/face');
const ai = require('../lib/ai');

const TMP = '/tmp/klip_v17_test';
const SIM = '/tmp/klip_v16_test/simulasi_podcast.mp4'; // orang kanan 0-30s, kiri 30-60s
const USER = '/home/z/my-project/upload/WhatsApp Video 2026-10-23 at 09.32.32.mp4';
const MODELS = '/tmp/klip_v16_test/models';

function fakeWords(start, end) {
  const kata = ['ini', 'contoh', 'subtitle', 'baru', 'v170', 'keren', 'sekali', 'kawan', 'test', 'render'];
  const words = [];
  let t = start + 1, i = 0;
  while (t < end - 1) {
    words.push({ text: kata[i % kata.length], start: t, end: t + 0.45 });
    t += 0.7; i++;
  }
  return words;
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  await ai.init(MODELS);

  // ---------- 1. DETEKSI LETTERBOX ----------
  console.log('== 1. Deteksi bar hitam (letterbox) ==');
  // buat video dgn bar hitam dari pola warna penuh: konten 1800x1012 di frame 1920x1080
  const LB = path.join(TMP, 'letterbox_sim.mp4');
  await video.run('ffmpeg', ['-y', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=1800x1012:duration=20:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=20',
    '-vf', 'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '96k', '-shortest', LB]);
  const lb1 = await video.detectLetterbox('ffmpeg', LB, 20, 1920, 1080);
  console.log('Letterbox sintetis:', JSON.stringify(lb1), '(diharapkan ~1800x1012)');
  if (!lb1 || Math.abs(lb1.w - 1800) > 40) throw new Error('deteksi letterbox sintetis meleset');

  // video penuh tanpa letterbox → tidak boleh dipotong
  const FULL = path.join(TMP, 'full_sim.mp4');
  await video.run('ffmpeg', ['-y', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:duration=20:rate=30',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', FULL]);
  const lbNone = await video.detectLetterbox('ffmpeg', FULL, 20, 1920, 1080);
  console.log('Video polos tanpa bar:', lbNone ? 'TERDETEKSI (SALAH!)' : 'tidak ada (OK)');
  if (lbNone) throw new Error('false positive pada video tanpa letterbox');

  const { duration: durUser } = await video.probeDuration('ffprobe', USER);
  const lb2 = await video.detectLetterbox('ffmpeg', USER, durUser, 1080, 1920);
  console.log('Letterbox video user:', lb2 ? JSON.stringify(lb2) : 'tidak ada (OK — bar hitam bawaan sangat tipis)');
  const { info: infoSim } = await video.probeDuration('ffprobe', SIM);
  console.log('Video simulasi face tracking:', infoSim.streams.find(s => s.width).width + 'x' + infoSim.streams.find(s => s.width).height);

  // ---------- 2. FACE TRACK MODE SNAP ----------
  console.log('\n== 2. Face tracking mode CUT LANGSUNG (snap) ==');
  const bins = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', binDir: '.', assetsDir: path.join(__dirname, '..', 'assets'), fontsDir: null };
  const moments = [{ start: 10, end: 50, title: 'ganti pembicara' }]; // mencakup switch di t=30
  const t0 = Date.now();
  const tracks = await face.buildTracks(bins, moments, SIM, path.join(TMP, 'work'), MODELS, {
    meta: { width: 1920, height: 1080 },
    mode: 'snap', fmt: 'full916',
    log: (m) => console.log('[face]', m)
  });
  console.log('waktu face tracking:', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  const tr = tracks.get(0);
  if (!tr || !tr.snap) throw new Error('track snap tidak dihasilkan');
  console.log('Step points:', tr.points.map(p => `t=${p.t.toFixed(1)}s cx=${p.cx.toFixed(0)}`).join(' | '));
  if (tr.points.length < 2) throw new Error('seharusnya ada >= 2 segmen posisi (orang kanan lalu kiri)');
  const cx0 = tr.points[0].cx, cx1 = tr.points[tr.points.length - 1].cx;
  const gap = Math.abs(cx0 - cx1);
  console.log(`Jarak antar posisi crop: ${gap.toFixed(0)} px (harus > 700 utk kanan→kiri)`);
  if (gap < 700) throw new Error('posisi cut tidak berganti dengan signifikan');

  // ---------- 3. RENDER FULL916: letterbox + snap + caption + subtitle ----------
  console.log('\n== 3. Render full916 (trim hitam + cut langsung + caption + subtitle) ==');
  const sourceFile = LB; // pakai video letterbox → hasil harus penuh tanpa hitam
  const vw = lb1.w, vh = lb1.h;
  const m = moments[0];
  const clipTmp = path.join(TMP, 'r1');
  fs.mkdirSync(clipTmp, { recursive: true });
  const assFile = subs.writeAss(fakeWords(m.start, m.end), clipTmp, {
    fmt: 'full916', style: 'pop', clipStart: m.start, clipEnd: m.end,
    position: 'bottom', color: '#FFFFFF', font: 'poppins', size: 'normal', outline: 'normal',
    caption: { text: '3 RAHASIA SUKSES', position: 'top' }
  });
  console.log('ASS dibuat:', !!assFile, '| berisi style Caption:', fs.readFileSync(assFile, 'utf8').includes('Style: Caption'));
  const fc = video.buildFilterScript('full916', {
    subsFile: 'subs.ass',
    musicInput: path.join(__dirname, '..', 'assets', 'music', 'lofi_chill.mp3'),
    musicVolume: 0.2, musicDuck: true,
    clipDur: m.end - m.start,
    faceTrack: tr,
    letterboxCrop: lb1
  });
  console.log('filter awal:', fc.split(';')[0]);
  fs.writeFileSync(path.join(clipTmp, 'fc.txt'), fc, 'utf8');
  for (const f of fs.readdirSync('resources/fonts')) {
    fs.copyFileSync(path.join('resources/fonts', f), path.join(clipTmp, f));
  }
  const outFile = path.join(TMP, 'klip_v17_full.mp4');
  await video.renderClip('ffmpeg', sourceFile, outFile, {
    start: m.start, end: m.end, cwd: clipTmp,
    filterComplex: fc, filterScriptFile: 'fc.txt',
    musicInput: path.join(__dirname, '..', 'assets', 'music', 'lofi_chill.mp3'),
    onProgress: (p) => process.stdout.write(`\r  render ${p.toFixed(0)}%`)
  });
  console.log('');
  const { info } = await video.probeDuration('ffprobe', outFile);
  const vs = info.streams.find((s) => s.codec_type === 'video');
  console.log(`Hasil: ${vs.width}x${vs.height}, ${(fs.statSync(outFile).size / 1048576).toFixed(1)}MB`);
  if (vs.width !== 1080 || vs.height !== 1920) throw new Error('resolusi bukan 1080x1920');

  console.log('\nRENDER v1.7 TEST PASSED ✅');
}

main().catch((e) => { console.error('FATAL', e.message || e); process.exit(1); });
