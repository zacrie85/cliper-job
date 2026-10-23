/*
 * Test v1.5.0 - Render nyata: semua efek cinematik + semua 10 font
 * memakai ffmpeg lokal (sandbox = ffmpeg 7.1, produksi Windows = ffmpeg 8).
 * Setiap render harus sukses (exit 0) & output > 20KB.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const video = require('../lib/video');
const subs = require('../lib/subs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'render15-'));
const FONTS_DIR = path.join(__dirname, '..', 'resources', 'fonts');
const FFMPEG = 'ffmpeg';
let pass = 0, fail = 0;

function run(args) {
  return execFileSync(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/* Sumber uji: video 5 dtk + audio nada bergerak */
const src = path.join(TMP, 'src.mp4');
console.log('Membuat video uji 5 dtk...');
run(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
  '-t', '5', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', src]);

const words = [
  { text: 'RAHASIA', start: 0.2, end: 0.9 },
  { text: 'cara', start: 0.9, end: 1.3 },
  { text: 'dapat', start: 1.3, end: 1.7 },
  { text: 'cuan?', start: 1.7, end: 2.3 },
  { text: 'gila', start: 2.3, end: 2.8 },
  { text: 'benar!', start: 2.8, end: 3.4 }
];

async function t(name, fn) {
  try { await fn(); pass++; console.log('PASS -', name); }
  catch (e) { fail++; console.error('FAIL -', name, '\n    ', String(e && e.message || e).slice(0, 400)); }
}

(async () => {
  // ---------- 6 efek cinematik ----------
  const effects = ['none', 'classic', 'dramatis', 'vintage', 'zoom', 'mono'];
  for (const eff of effects) {
    await t(`render efek "${eff}" (full916 + subtitle hijau + font anton)`, () => {
      const dir = path.join(TMP, 'eff-' + eff);
      fs.mkdirSync(dir, { recursive: true });
      const ass = subs.writeAss(words, dir, {
        fmt: 'full916', style: 'pop', clipStart: 0, clipEnd: 5,
        position: 'bottom', color: '#00E676', font: 'anton'
      });
      assert.ok(ass, 'subs.ass harus dibuat');
      for (const f of fs.readdirSync(FONTS_DIR)) fs.copyFileSync(path.join(FONTS_DIR, f), path.join(dir, f));
      const fc = video.buildFilterScript('full916', { subsFile: 'subs.ass', effect: eff, clipDur: 5 });
      fs.writeFileSync(path.join(dir, 'fc.txt'), fc, 'utf8');
      const out = path.join(dir, 'out.mp4');
      execFileSync(FFMPEG, [
        '-y', '-nostdin', '-ss', '0', '-i', src, '-t', '4',
        '-filter_complex', fc, '-map', '[vout]', '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '44100', '-movflags', '+faststart', out
      ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      const sz = fs.statSync(out).size;
      assert.ok(sz > 20000, 'output terlalu kecil: ' + sz);
    });
  }

  // ---------- 10 font ----------
  const fonts = Object.keys(subs.FONTS);
  for (const fk of fonts) {
    await t(`render font "${fk}" (${subs.FONTS[fk].family})`, () => {
      const dir = path.join(TMP, 'font-' + fk);
      fs.mkdirSync(dir, { recursive: true });
      const ass = subs.writeAss(words, dir, {
        fmt: 'full916', style: 'karaoke', clipStart: 0, clipEnd: 5,
        position: 'center', color: '#FFD400', font: fk
      });
      assert.ok(ass, 'subs.ass harus dibuat');
      for (const f of fs.readdirSync(FONTS_DIR)) fs.copyFileSync(path.join(FONTS_DIR, f), path.join(dir, f));
      const fc = video.buildFilterScript('full916', { subsFile: 'subs.ass', effect: 'none', clipDur: 5 });
      const out = path.join(dir, 'out.mp4');
      execFileSync(FFMPEG, [
        '-y', '-nostdin', '-ss', '0', '-i', src, '-t', '1.5',
        '-filter_complex', fc, '-map', '[vout]', '-map', '[aout]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-ar', '44100', out
      ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      assert.ok(fs.statSync(out).size > 20000);
    });
  }

  // ---------- efek zoom pada format 'original' ----------
  await t('render efek "zoom" pada format original (normalisasi 1280x720)', () => {
    const dir = path.join(TMP, 'eff-zoom-orig');
    fs.mkdirSync(dir, { recursive: true });
    const fc = video.buildFilterScript('original', { effect: 'zoom', clipDur: 5 });
    const out = path.join(dir, 'out.mp4');
    execFileSync(FFMPEG, [
      '-y', '-nostdin', '-ss', '0', '-i', src, '-t', '3',
      '-filter_complex', fc, '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '44100', out
    ], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(fs.statSync(out).size > 20000);
  });

  console.log(`\n=== ${pass} pass, ${fail} fail ===  (tmp: ${TMP})`);
  process.exit(fail ? 1 : 0);
})();
