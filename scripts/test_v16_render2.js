/* test_v16_render2.js — render 2 klip dari simulasi podcast realistis */
const path = require('path');
const fs = require('fs');
const video = require('../lib/video');
const subs = require('../lib/subs');
const face = require('../lib/face');
const ai = require('../lib/ai');

(async () => {
  const SRC = '/tmp/klip_v16_test/podcast2.mp4';
  const TMP = '/tmp/klip_v16_render2';
  const BGM = path.join(__dirname, '..', 'assets', 'music', 'lofi_chill.mp3');
  fs.mkdirSync(TMP, { recursive: true });
  await ai.init('/tmp/klip_v16_test/models');
  const bins = { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', binDir: '.', assetsDir: path.join(__dirname, '..', 'assets'), fontsDir: null };
  const moments = [
    { start: 3, end: 27, title: 'orang KIRI' },
    { start: 33, end: 57, title: 'orang KANAN' }
  ];
  const tracks = await face.buildTracks(bins, moments, SRC, path.join(TMP, 'w'), '/tmp/klip_v16_test/models', {
    meta: { width: 1920, height: 1080 }, log: (m) => console.log('[face]', m)
  });
  const kata = ['face', 'tracking', 'berhasil', 'kawan', 'v160', 'mantap'];
  for (let i = 0; i < 2; i++) {
    const m = moments[i];
    const outFile = path.join(TMP, 'out_' + (i + 1) + '.mp4');
    const clipTmp = path.join(TMP, 'r' + (i + 1));
    fs.mkdirSync(clipTmp, { recursive: true });
    const words = [];
    let t = m.start + 1, k = 0;
    while (t < m.end - 1) { words.push({ text: kata[k % kata.length], start: t, end: t + 0.4 }); t += 0.8; k++; }
    const assFile = subs.writeAss(words, clipTmp, {
      fmt: 'full916', style: 'pop', clipStart: m.start, clipEnd: m.end,
      position: 'center', color: '#FFFFFF', font: 'poppins', size: 'big', outline: 'box'
    });
    const fc = video.buildFilterScript('full916', {
      subsFile: assFile ? 'subs.ass' : null,
      musicInput: BGM, sfxInput: null,
      musicVolume: 0.25, musicDuck: true, effect: 'none',
      clipDur: m.end - m.start, faceTrack: tracks.get(i) || null
    });
    fs.writeFileSync(path.join(clipTmp, 'fc.txt'), fc, 'utf8');
    await video.renderClip('ffmpeg', SRC, outFile, {
      start: m.start, end: m.end, cwd: clipTmp, filterComplex: fc, filterScriptFile: 'fc.txt',
      musicInput: BGM, musicVolume: 0.25
    });
    console.log('render klip', i + 1, 'OK ->', outFile);
  }
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
