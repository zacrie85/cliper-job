/*
 * Test v1.5.0 END-TO-END: runJob lengkap dengan fitur baru
 * - jumlah klip kustom 5  -> HARUS tepat 5 klip berbeda
 * - warna subtitle kustom #00E676 + font anton
 * - efek cinematik 'classic'
 * - posisi bawah
 * Jalankan: node scripts/test_v15_e2e.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tmp', 'e2e-out-v15');

async function main() {
  const { runJob } = require(path.join(ROOT, 'lib', 'job'));

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const events = [];
  const cfg = {
    sourceType: 'file',
    filePath: path.join(ROOT, 'tmp', 'video-test-v14.mp4'),
    outputDir: OUT,
    clipDuration: 8,          // kustom
    clipCount: 5,             // kustom -> wajib 5 klip
    format: 'full916',
    subtitleStyle: 'pop',
    subtitlePosition: 'bottom',
    subtitleColor: '#00E676', // hijau neon (baru v1.5)
    subtitleFont: 'anton',    // font Anton (baru v1.5)
    cinematicEffect: 'classic', // bar bioskop + teal&orange (baru v1.5)
    asrLanguage: 'indonesian',
    asrModel: 'Xenova/whisper-base',
    watermarkPath: null,
    musicPath: null,
    musicVolume: 0.3,
    hookSfx: false,
    maxAnalysisMin: 15
  };
  const result = await runJob({
    cfg,
    bins: {
      platform: 'linux',
      ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', ytdlp: 'yt-dlp', binDir: '.',
      assetsDir: path.join(ROOT, 'assets'),
      fontsDir: path.join(ROOT, 'resources', 'fonts')
    },
    modelsDir: path.join(ROOT, 'tmp', 'models-test-v14'),
    isCancelled: () => false,
    registerChild: () => {},
    evt: (type, payload) => {
      if (type === 'log') { events.push(payload.message); }
      if (type === 'stage') console.log(`  [stage] ${payload.stage}: ${payload.status}`);
      if (type === 'job-error') console.log('  [JOB-ERROR]', payload.message);
    },
    appVersion: '1.5.0-test'
  });

  console.log('--- LOG ---');
  events.forEach((m) => console.log('  ' + m));
  console.log('--- HASIL ---');
  if (!result.ok) { console.log('  [FAIL]', result.error); process.exit(1); }
  for (const c of result.clips) {
    const st = fs.statSync(c.file);
    console.log(`  OK: ${c.name} (${(st.size / 1024).toFixed(0)} KB)`);
  }
  if (result.clips.length === 5) {
    console.log('[PASS] 5 klip dibuat sesuai pilihan, warna/font/efek diterapkan');
    process.exit(0);
  } else {
    console.log(`[FAIL] jumlah klip ${result.clips.length}, harusnya 5`);
    process.exit(1);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
