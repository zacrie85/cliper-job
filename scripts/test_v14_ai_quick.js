/*
 * Test v1.4.0 cepat: whisper-base transkripsi ID/EN + language auto
 * Jalankan: node scripts/test_v14_ai_quick.js [modelId] [language]
 */
const path = require('path');

const MODEL = process.argv[2] || 'Xenova/whisper-base';
const LANG = process.argv[3] || 'indonesian';

async function main() {
  const ROOT = path.join(__dirname, '..');
  const ai = require(path.join(ROOT, 'lib', 'ai'));
  await ai.init(path.join(ROOT, 'tmp', 'models-test-v14'), {});
  console.log(`[1] Model ${MODEL} (lang=${LANG})...`);
  // Catatan: alur aplikasi asli TIDAK memuat pipeline small di proses utama
  // (hanya lewat ensureASRReady/child). Di sini kita ikuti alur itu:
  if (/small/i.test(MODEL)) {
    await ai.ensureASRReady(MODEL, (p) => {
      if (p.status === 'progress' && p.total) {
        console.log(`    download ${p.file} ${((p.loaded / p.total) * 100).toFixed(0)}%`);
      }
    });
  } else {
    await ai.ensureASR(MODEL, () => {});
  }
  const t1 = Date.now();
  const words = await ai.transcribeWavChunks(
    [path.join(ROOT, 'tmp', 'audio-test-v14-16k.wav')],
    null,
    { modelId: MODEL, language: LANG }
  );
  const secs = ((Date.now() - t1) / 1000).toFixed(1);
  const text = words.map((w) => w.text).join(' ');
  console.log(`[2] Selesai dalam ${secs}s, ${words.length} kata`);
  console.log('[2] HASIL: ' + text.slice(0, 500));
  const low = text.toLowerCase();
  const checks = {
    'ID (rahasia|viral|konten|channel)': /(rahasia|viral|konten|channel)/.test(low),
    'EN (important|views|tiktok|channel)': /(important|views|tiktok|channel)/.test(low),
    'slang (gila|gampang|banget|seriusan)': /(gila|gampang|banget|seriusan)/.test(low)
  };
  for (const [k, ok] of Object.entries(checks)) console.log(`    [${ok ? 'PASS' : 'MISS'}] ${k}`);
  console.log('[DONE]');
}

main().catch((e) => { console.error('FATAL:', e && e.message || e); process.exit(1); });
