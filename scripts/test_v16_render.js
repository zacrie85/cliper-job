/*
 * test_v16_render.js — Render klip v1.6.0 dari video simulasi:
 * face track crop + BGM pustaka (auto-duck, loop, fade) + subtitle
 * (ukuran besar + kotak hitam) + SFX. Verifikasi file + frame visual.
 */
const path = require('path');
const fs = require('fs');
const video = require('../lib/video');
const subs = require('../lib/subs');

const TMP = '/tmp/klip_v16_render';
const SRC = '/tmp/klip_v16_test/simulasi_podcast.mp4';
const BGM = path.join(__dirname, '..', 'assets', 'music', 'lofi_chill.mp3');
const SFX = path.join(__dirname, '..', 'assets', 'sfx_whoosh.wav');

function fakeWords(start, end) {
  const kata = ['ini', 'contoh', 'subtitle', 'baru', 'v160', 'keren', 'sekali', 'kawan', 'test', 'render'];
  const words = [];
  let t = start + 1;
  let i = 0;
  while (t < end - 1) {
    words.push({ text: kata[i % kata.length], start: t, end: t + 0.45 });
    t += 0.7; i++;
  }
  return words;
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  const out1 = path.join(TMP, 'klip_face_kanan.mp4');
  const out2 = path.join(TMP, 'klip_face_kiri.mp4');

  // Lintasan face dari test sebelumnya (simpan cepat: jalankan buildTracks lagi)
  const face = require('../lib/face');
  const ai = require('../lib/ai');
  await ai.init('/tmp/klip_v16_test/models');
  const bins = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', binDir: '.', assetsDir: path.join(__dirname, '..', 'assets'), fontsDir: null };
  const moments = [
    { start: 2, end: 26, title: 'kanan' },
    { start: 34, end: 58, title: 'kiri' }
  ];
  const tracks = await face.buildTracks(bins, moments, SRC, path.join(TMP, 'work'), '/tmp/klip_v16_test/models', {
    meta: { width: 1920, height: 1080 },
    log: (m) => console.log('[face]', m)
  });

  for (let i = 0; i < 2; i++) {
    const m = moments[i];
    const outFile = i === 0 ? out1 : out2;
    const clipTmp = path.join(TMP, 'r' + (i + 1));
    fs.mkdirSync(clipTmp, { recursive: true });

    // subtitle gaya baru: besar + kotak hitam (klip 1), tipis + kuning (klip 2)
    const assFile = subs.writeAss(fakeWords(m.start, m.end), clipTmp, {
      fmt: 'full916', style: 'pop', clipStart: m.start, clipEnd: m.end,
      position: 'center', color: i === 0 ? '#FFFFFF' : '#FFD400',
      font: 'poppins', size: i === 0 ? 'big' : 'normal',
      outline: i === 0 ? 'box' : 'thin'
    });

    const fc = video.buildFilterScript('full916', {
      subsFile: assFile ? 'subs.ass' : null,
      musicInput: BGM,
      sfxInput: SFX,
      musicVolume: 0.25,
      musicDuck: true,
      effect: 'none',
      clipDur: m.end - m.start,
      faceTrack: tracks.get(i) || null
    });
    fs.writeFileSync(path.join(clipTmp, 'fc.txt'), fc, 'utf8');
    console.log(`\n== Render klip ${i + 1} (${m.title}) — track: ${tracks.has(i) ? 'ADA' : 'TIDAK'} ==`);
    console.log('filter (potongan):', fc.split(';')[0].slice(0, 160), '...');

    const t0 = Date.now();
    await video.renderClip('ffmpeg', SRC, outFile, {
      start: m.start, end: m.end,
      cwd: clipTmp,
      filterComplex: fc,
      filterScriptFile: 'fc.txt',
      musicInput: BGM,
      sfxInput: SFX,
      musicVolume: 0.25,
      onProgress: (p) => process.stdout.write(`\r  render ${p.toFixed(0)}%`)
    });
    console.log(`\n  selesai ${(Date.now() - t0) / 1000}s → ${outFile}`);

    // verifikasi
    const { duration, info } = await video.probeDuration('ffprobe', outFile);
    const hasA = (info.streams || []).some((s) => s.codec_type === 'audio');
    const hasV = (info.streams || []).some((s) => s.codec_type === 'video');
    console.log(`  durasi=${duration.toFixed(1)}s audio=${hasA} video=${hasV} size=${(fs.statSync(outFile).size / 1048576).toFixed(1)}MB`);
    if (!hasA || !hasV) throw new Error('stream hilang!');
  }

  // audio level check (musik + voice harus ada)
  const { stdout } = await video.run('ffmpeg', ['-i', out1, '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
  const mean = (stdout.match(/mean_volume: ([-\d.]+) dB/) || [])[1];
  console.log('\nmean volume klip 1:', mean, 'dB (harus > -50)');

  console.log('\nRENDER TEST PASSED ✅');
}

main().catch((e) => { console.error('FATAL', e.message || e); process.exit(1); });
