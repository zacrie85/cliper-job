/* eksperimen ukuran input YOLOS utk percepatan */
const path = require('path');
const fs = require('fs');
const TMP = '/tmp/klip_v16_prof';
async function main() {
  const ai = require('/home/z/my-project/cliper-job/lib/ai');
  await ai.init(path.join(TMP, 'models'));
  const det = await ai.ensureObjDetector();

  // frame test dari video user (2 orang)
  const frame = path.join(TMP, 'f.jpg');
  const frame2 = path.join(TMP, 'f2.jpg');
  for (const [f, ss] of [[frame, '10'], [frame2, '45']]) {
    await new Promise((res, rej) => {
      const c = require('child_process').spawn('ffmpeg', ['-y', '-ss', ss, '-i', '/home/z/my-project/upload/WhatsApp Video 2026-10-23 at 09.32.32.mp4', '-frames:v', '1', '-vf', 'scale=384:-2', f]);
      c.on('close', (k) => k === 0 ? res() : rej(new Error('ff')));
    });
  }

  const ips = det.processor.feature_extractor;
  console.log('size default:', JSON.stringify(ips.size));

  const trials = [
    ['default', null],
    ['512x288', { width: 512, height: 288 }],
    ['448x256', { width: 448, height: 256 }],
    ['384x384', { width: 384, height: 384 }],
    ['320x192', { width: 320, height: 192 }],
  ];
  const orig = { ...ips.size };
  for (const [label, size] of trials) {
    if (size) ips.size = size; else ips.size = orig;
    const times = [];
    let persons = [];
    for (const f of [frame, frame2, frame, frame2]) {
      const s = Date.now();
      const out = await det(f, { threshold: 0.55, percentage: false });
      times.push(Date.now() - s);
      if (persons.length < 2) persons.push(out.filter(r => r.label === 'person').map(r => r.score.toFixed(2)).join('+'));
    }
    console.log(label.padEnd(10), 'avg', Math.round(times.reduce((a, b) => a + b) / times.length) + 'ms', '| person:', persons.join(' | '));
  }
  ips.size = orig;
}
main().catch((e) => { console.error(e); process.exit(1); });
