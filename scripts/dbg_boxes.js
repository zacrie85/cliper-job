/* debug: dump semua box 'person' per frame pada segmen awal klip 1 simulasi */
const path = require('path');
const fs = require('fs');
async function main() {
  const TMP = '/tmp/klip_v16_dbg';
  fs.mkdirSync(TMP, { recursive: true });
  const ai = require('/home/z/my-project/cliper-job/lib/ai');
  await ai.init('/tmp/klip_v16_test/models');
  const det = await ai.ensureObjDetector();

  const frames = [];
  for (let i = 0; i < 12; i++) {
    const f = path.join(TMP, 'd' + i + '.jpg');
    await new Promise((res, rej) => {
      const c = require('child_process').spawn('ffmpeg', ['-y', '-ss', String(2 + i / 3), '-i', '/tmp/klip_v16_test/simulasi_podcast.mp4', '-frames:v', '1', '-vf', 'scale=384:-2', f]);
      c.on('close', (k) => k === 0 ? res() : rej(new Error('ff')));
    });
    frames.push(f);
  }
  for (let i = 0; i < frames.length; i++) {
    const out = await det(frames[i], { threshold: 0.5, percentage: false });
    const persons = out.filter(r => r.label === 'person')
      .map(r => `s=${r.score.toFixed(2)} x=${r.box.xmin.toFixed(0)}-${r.box.xmax.toFixed(0)} y=${r.box.ymin.toFixed(0)}-${r.box.ymax.toFixed(0)} w=${(r.box.xmax - r.box.xmin).toFixed(0)} h=${(r.box.ymax - r.box.ymin).toFixed(0)}`);
    console.log(`t=${(i / 3).toFixed(2)}s:`, persons.length ? persons.join('  ||  ') : '(kosong)');
  }
}
main().catch(e => { console.error(e); process.exit(1); });
