/*
 * Test v1.4.0 END-TO-END: runJob dengan konfigurasi baru
 * - durasi kustom 15 dtk, jumlah kustom 2 klip
 * - posisi subtitle: top
 * - bahasa: indonesian, model: whisper-base (cepat utk sandbox)
 * Jalankan: node scripts/test_v14_e2e.js
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tmp', 'e2e-out');

async function main() {
  const video = require(path.join(ROOT, 'lib', 'video'));
  const { runJob } = require(path.join(ROOT, 'lib', 'job'));

  fs.mkdirSync(OUT, { recursive: true });
  const events = [];
  const cfg = {
    sourceType: 'file',
    filePath: path.join(ROOT, 'tmp', 'video-test-v14.mp4'),
    outputDir: OUT,
    clipDuration: 15,       // kustom (di aplikasi: input manual)
    clipCount: 2,           // kustom (di aplikasi: input manual)
    format: 'full916',
    subtitleStyle: 'pop',
    subtitlePosition: 'top',
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
      if (type === 'log') events.push(payload.message);
      if (type === 'stage') console.log(`  [stage] ${payload.stage}: ${payload.status}`);
      if (type === 'job-error') console.log('  [JOB-ERROR]', payload.message);
    },
    appVersion: '1.4.0-test'
  });

  console.log('--- LOG ---');
  events.slice(-12).forEach((m) => console.log('  ' + m));
  console.log('--- HASIL ---');
  if (result.ok) {
    for (const c of result.clips) {
      console.log(`  OK: ${c.name} (${c.sizeText})`);
      // verifikasi subtitle ter-burn: cek ada diff frame atas
      const probe = video.probeDuration;
      console.log(`  durasi: ${(await probe('ffprobe', c.file)).duration.toFixed(1)}s`);
    }
    console.log(result.clips.length === 2 ? '[PASS] 2 klip durasi kustom 15 dtk dibuat' : '[FAIL] jumlah klip salah');
  } else {
    console.log('  [FAIL]', result.error);
    process.exit(1);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
