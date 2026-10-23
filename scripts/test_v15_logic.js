/*
 * Test v1.5.0 - Logika multi-klip (jendela waktu), subtitle font/warna,
 * dan grafik filter efek cinematik. Tanpa model AI (runLLM diinjeksi).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const ai = require('../lib/ai');
const subs = require('../lib/subs');
const video = require('../lib/video');

let pass = 0, fail = 0;
const TESTS = [];
function t(name, fn) { TESTS.push({ name, fn }); }

/* ---------- 1. planWindows ---------- */
t('planWindows: 5 klip x 60dtk pada video 300dtk -> 5 jendela disjoint', () => {
  const p = ai.planWindows(300, 5, 60);
  assert.strictEqual(p.windows.length, 5);
  assert.strictEqual(p.target, 60);
  assert.strictEqual(p.note, null);
  for (let i = 1; i < p.windows.length; i++) {
    assert.ok(Math.abs(p.windows[i].ws - p.windows[i - 1].we) < 1e-9, 'jendela harus bersambung');
  }
});

t('planWindows: video 120dtk minta 5 x 60dtk -> durasi menyusut jadi 24dtk', () => {
  const p = ai.planWindows(120, 5, 60);
  assert.strictEqual(p.windows.length, 5);
  assert.strictEqual(p.target, 24);
  assert.ok(p.note && /24/.test(p.note));
});

t('planWindows: jumlah klip 1-30 dipaksa valid', () => {
  assert.strictEqual(ai.planWindows(600, 99, 30).windows.length, 30);
  assert.strictEqual(ai.planWindows(600, 0, 30).windows.length, 1);
});

/* ---------- 2. analyzeMoments: jumlah klip PASTI sesuai ---------- */
function fakeSegments(n, dur) {
  const segs = [];
  for (let i = 0; i < n; i++) {
    segs.push({
      start: (dur / n) * i,
      end: (dur / n) * (i + 1) - 0.3,
      text: i % 3 === 0 ? 'ini rahasia cara dapat uang banyak?' : 'biasa saja cerita panjang lebar'
    });
  }
  return segs;
}

t('analyzeMoments: minta 5 klip -> TEPAT 5 momen berbeda & tidak tumpang tindih (heuristik)', async () => {
  const segs = fakeSegments(40, 300);
  const logs = [];
  const moments = await ai.analyzeMoments(segs, 300, 30, 5, (m) => logs.push(m), {
    runLLM: async () => null // LLM gagal -> harus tetap 5 klip dari heuristik
  });
  assert.strictEqual(moments.length, 5, 'harus tepat 5, dapat: ' + JSON.stringify(moments));
  for (let i = 0; i < moments.length; i++) {
    assert.ok(moments[i].end > moments[i].start, 'start<end');
    if (i > 0) assert.ok(moments[i].start >= moments[i - 1].end, 'tidak boleh tumpang tindih');
  }
});

t('analyzeMoments: LLM balas HANYA 1 momen -> tetap dihasilkan 5 klip berbeda', async () => {
  const segs = fakeSegments(40, 300);
  const moments = await ai.analyzeMoments(segs, 300, 30, 5, () => {}, {
    runLLM: async () => ({ text: '12,"end":42,"title":"rahasia cuan"}]' }) // cuma 1 item
  });
  assert.strictEqual(moments.length, 5);
  const uniq = new Set(moments.map((m) => m.start + '-' + m.end));
  assert.strictEqual(uniq.size, 5, 'semua momen harus unik');
});

t('analyzeMoments: LLM balas 5 momen valid per jendela -> dipakai & tetap 5', async () => {
  const segs = fakeSegments(40, 300);
  const moments = await ai.analyzeMoments(segs, 300, 30, 5, () => {}, {
    runLLM: async () => ({
      text: '30,"end":60,"title":"A"},{"start":90,"end":120,"title":"B"},{"start":150,"end":180,"title":"C"},{"start":210,"end":240,"title":"D"},{"start":270,"end":300,"title":"E"}]'
    })
  });
  assert.strictEqual(moments.length, 5);
  assert.strictEqual(moments[0].title, 'A');
  assert.strictEqual(moments[4].title, 'E');
});

t('analyzeMoments: 8 klip pada video 90 dtk -> 8 klip dengan durasi menyusut otomatis', async () => {
  const segs = fakeSegments(30, 90);
  const moments = await ai.analyzeMoments(segs, 90, 30, 8, () => {}, { runLLM: async () => null });
  assert.strictEqual(moments.length, 8, 'harus tetap 8 klip');
  for (const m of moments) assert.ok(m.end - m.start >= 5 && m.end - m.start <= 30);
});

t('analyzeMoments: minta 12 klip -> 12 momen', async () => {
  const segs = fakeSegments(120, 900);
  const moments = await ai.analyzeMoments(segs, 900, 25, 12, () => {}, { runLLM: async () => null });
  assert.strictEqual(moments.length, 12);
});

/* ---------- 3. Subtitle: font & warna ---------- */
t('writeAss: 10 font terdaftar & file TTF semuanya ada di resources/fonts', () => {
  const keys = Object.keys(subs.FONTS);
  assert.strictEqual(keys.length, 10, 'harus 10 font');
  const dir = path.join(__dirname, '..', 'resources', 'fonts');
  for (const k of keys) {
    assert.ok(fs.existsSync(path.join(dir, subs.FONTS[k].file)), 'file hilang: ' + subs.FONTS[k].file);
  }
});

t('writeAss: warna kustom dipakai sebagai PrimaryColour & outline kontras', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subs15-'));
  const words = [{ text: 'halo', start: 0, end: 0.5 }, { text: 'dunia?', start: 0.5, end: 1.0 }];
  const f = subs.writeAss(words, tmp, { fmt: 'full916', style: 'pop', clipStart: 0, clipEnd: 3, position: 'bottom', color: '#00E676', font: 'anton' });
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('Style: Pop,Anton,'), 'font Anton harus dipakai');
  // #00E676 -> BGR 76E600 -> &H0076E600
  assert.ok(content.includes('&H0076E600'), 'PrimaryColour hijau: ' + content.split('\n').find(l => l.startsWith('Style: Pop')));
  assert.ok(content.includes('&H001A1A1A'), 'outline gelap untuk warna terang');
  fs.rmSync(tmp, { recursive: true, force: true });
});

t('writeAss: warna gelap -> outline putih; warna kuning -> hook putih', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'subs15-'));
  const words = [{ text: 'tes', start: 0, end: 0.5 }];
  const f = subs.writeAss(words, tmp, { fmt: 'full916', style: 'pop', clipStart: 0, clipEnd: 2, position: 'center', color: '#1A1A1A', font: 'poppins' });
  const content = fs.readFileSync(f, 'utf8');
  assert.ok(content.includes('&H00FFFFFF'), 'outline harus putih');
  const p = subs.paletteFor('#FFD400');
  assert.strictEqual(p.hook, '#FFFFFF', 'hook putih jika teks kuning');
  const p2 = subs.paletteFor(null);
  assert.strictEqual(p2.primary, '#FFFFFF');
  assert.strictEqual(p2.hook, '#FFD400');
  fs.rmSync(tmp, { recursive: true, force: true });
});

t('writeAss: font Bebas Neue & bold flag benar (montserrat bold=1)', () => {
  assert.strictEqual(subs.fontDef('bebas').family, 'Bebas Neue');
  assert.strictEqual(subs.fontDef('montserrat').bold, 1);
  assert.strictEqual(subs.fontDef('tidak-ada'), subs.FONTS.poppins, 'font tak dikenal -> fallback poppins');
});

/* ---------- 4. Filter efek cinematik ---------- */
t('buildFilterScript: effect classic memakai colorbalance + drawbox bar', () => {
  const s = video.buildFilterScript('full916', { effect: 'classic', clipDur: 30 });
  assert.ok(/colorbalance=rs=0\.06/.test(s), s);
  assert.ok(/drawbox=.*black/.test(s));
  assert.ok(s.includes('[ce]null[vout]') || s.includes('[ce]'), s);
});

t('buildFilterScript: zoom memakai zoompan dengan s=1080x1920 untuk full916', () => {
  const s = video.buildFilterScript('full916', { effect: 'zoom', clipDur: 45 });
  assert.ok(/fps=30/.test(s));
  assert.ok(/zoompan=z='min\(1\.14,zoom\+0\.00010370\)'/i.test(s), 'rate harus 0.14/(45*30): ' + s);
  assert.ok(/s=1080x1920/.test(s));
});

t('buildFilterScript: none -> tidak ada rantai efek, label b0 langsung', () => {
  const s = video.buildFilterScript('full916', { effect: 'none', clipDur: 30 });
  assert.ok(s.includes('[b0]null[vout]'), s);
  assert.ok(!/zoompan|vignette|colorbalance/.test(s));
});

t('buildFilterScript: efek + subtitle + watermark berurutan benar', () => {
  const s = video.buildFilterScript('blur916', {
    effect: 'dramatis', clipDur: 20, subsFile: 'subs.ass', wmInput: 'wm.png'
  });
  const iEff = s.indexOf('vignette');
  const iWm = s.indexOf('overlay=W-w-40');
  const iAss = s.indexOf('ass=subs.ass');
  assert.ok(iEff > -1 && iWm > iEff && iAss > iWm, 'urutan: efek -> watermark -> subtitle\n' + s);
});

(async () => {
for (const { name, fn } of TESTS) {
  try { await fn(); pass++; console.log('PASS -', name); }
  catch (e) { fail++; console.error('FAIL -', name, '\n    ', e.message); }
}
console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail ? 1 : 0);
})();
