/* profil kecepatan YOLOS-tiny per frame */
const path = require('path');
const fs = require('fs');
const TMP = '/tmp/klip_v16_prof';
async function main() {
  fs.mkdirSync(TMP, { recursive: true });
  const ai = require('/home/z/my-project/cliper-job/lib/ai');
  await ai.init(path.join(TMP, 'models'));
  console.log('memuat YOLOS-tiny...');
  const t0 = Date.now();
  const det = await ai.ensureObjDetector((p) => {
    if (p.status === 'progress' && p.total) console.log('  dl', p.file, Math.round(p.loaded / p.total * 100) + '%');
  });
  console.log('model siap dalam', ((Date.now() - t0) / 1000).toFixed(1), 's');

  // siapkan 1 frame test
  const frame = path.join(TMP, 'f.jpg');
  await new Promise((res, rej) => {
    const c = require('child_process').spawn('ffmpeg', ['-y', '-ss', '10', '-i', '/home/z/my-project/upload/WhatsApp Video 2026-10-23 at 09.32.32.mp4', '-frames:v', '1', '-vf', 'scale=384:-2', frame]);
    c.on('close', (k) => k === 0 ? res() : rej(new Error('ff')));
  });

  // 5 inferensi berurutan
  const times = [];
  for (let i = 0; i < 5; i++) {
    const s = Date.now();
    const out = await det(frame, { threshold: 0.55, percentage: false });
    times.push(Date.now() - s);
    if (i === 0) console.log('hasil contoh:', JSON.stringify(out.map(r => ({ l: r.label, s: (r.score || 0).toFixed(2) }))));
  }
  console.log('waktu per frame (ms):', times.join(', '));
}
main().catch((e) => { console.error(e); process.exit(1); });
