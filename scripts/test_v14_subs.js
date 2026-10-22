/*
 * Test v1.4.0: posisi subtitle (atas/tengah/bawah) + render ffmpeg
 * Jalankan: node scripts/test_v14_subs.js
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'tmp', 'subs-test-v14');
const subs = require(path.join(ROOT, 'lib', 'subs'));

// Kalimat dummy dengan timing kata (bukan dari AI, cukup utk cek posisi)
const words = [];
const sentence = 'Halo guys rahasia konten viral ini gampang banget seriusan coba sekarang';
const t0 = 0.2;
sentence.split(' ').forEach((w, i) => {
  words.push({ text: w, start: t0 + i * 0.45, end: t0 + i * 0.45 + 0.4 });
});

function checkAnTag(file, expected) {
  const content = fs.readFileSync(file, 'utf8');
  const styleOk = content.includes(`,${expected},60,60,`) || content.match(new RegExp(`2,${expected},60,60,`));
  const anOk = content.includes(`\\an${expected}`);
  const styleLine = content.split('\n').find((l) => l.startsWith('Style: Pop'));
  const mv = styleLine.split(',')[21]; // MarginV kolom
  console.log(`    file=${path.basename(file)} an=${expected} tagAn=${anOk ? 'OK' : 'GAGAL'} MarginV=${mv}`);
  return anOk;
}

function main() {
  fs.mkdirSync(TMP, { recursive: true });
  // Video tes: 5 detik warna + nada
  const testVid = path.join(TMP, 'test_input.mp4');
  console.log('[1] Buat video tes 1080x1920 5 detik...');
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', testVid]);

  const positions = ['top', 'center', 'bottom'];
  let allOk = true;
  for (const pos of positions) {
    console.log(`[2] Posisi: ${pos}`);
    const dir = path.join(TMP, pos);
    fs.mkdirSync(dir, { recursive: true });
    const assPath = subs.writeAss(words, dir, {
      fmt: 'full916', style: 'pop', clipStart: 0, clipEnd: 5, position: pos
    });
    const expected = pos === 'top' ? 8 : pos === 'bottom' ? 2 : 5;
    if (!checkAnTag(assPath, expected)) allOk = false;
    // salin font agar libass menemukan Poppins
    for (const f of fs.readdirSync(path.join(ROOT, 'resources', 'fonts'))) {
      fs.copyFileSync(path.join(ROOT, 'resources', 'fonts', f), path.join(dir, f));
    }
    const out = path.join(dir, 'out.mp4');
    const fc = `[0:v]crop=ih*9/16:ih,scale=1080:1920,setsar=1[b0];[b0]ass=subs.ass:fontsdir=.[vs];[vs]null[vout];[0:a]anull[aout]`;
    console.log(`[3] Render ${pos} dengan ffmpeg...`);
    execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
      '-i', testVid, '-filter_complex', fc, '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-t', '5', out],
      { cwd: dir });
    const size = fs.statSync(out).size;
    console.log(`    OK: ${path.basename(out)} (${(size / 1024).toFixed(0)} KB)`);
    if (size < 10000) allOk = false;
  }
  console.log(allOk ? '[SELESAI] Semua posisi subtitle PASS' : '[GAGAL] Ada posisi yang bermasalah');
  process.exit(allOk ? 0 : 1);
}

main();
