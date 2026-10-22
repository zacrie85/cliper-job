/*
 * lib/llm_worker.js - CHILD PROCESS untuk inferensi LLM.
 * Dijalankan lewat `process.execPath` + ELECTRON_RUN_AS_NODE=1 supaya
 * kalau model memakan RAM berlebih dan di-kill OS, aplikasi utama tetap hidup.
 *
 * stdin : JSON { prompt, maxNewTokens }
 * stdout: baris "###CCP_RESULT###" diikuti JSON { ok, text } atau { ok:false, error }
 */
const path = require('path');
const fs = require('fs');

function main() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', async () => {
    let req;
    try { req = JSON.parse(raw); } catch (e) {
      process.stdout.write('###CCP_RESULT###' + JSON.stringify({ ok: false, error: 'stdin bukan JSON' }));
      process.exit(2);
    }
    try {
      const modelsDir = process.env.CCP_MODELS_DIR;
      const modelId = process.env.CCP_MODEL_ID || 'Xenova/Qwen1.5-0.5B-Chat';
      const { env, pipeline } = require('@xenova/transformers');
      env.cacheDir = modelsDir;
      env.localModelPath = modelsDir;
      env.allowLocalModels = true;
      env.allowRemoteModels = true;
      const gen = await pipeline('text-generation', modelId, { quantized: true });
      const out = await gen(req.prompt, {
        max_new_tokens: req.maxNewTokens || 220,
        do_sample: false,
        return_full_text: false,
        repetition_penalty: 1.15
      });
      let text = '';
      if (Array.isArray(out) && out[0] && out[0].generated_text) text = String(out[0].generated_text);
      process.stdout.write('###CCP_RESULT###' + JSON.stringify({ ok: true, text }));
      process.exit(0);
    } catch (err) {
      try {
        process.stdout.write('###CCP_RESULT###' + JSON.stringify({ ok: false, error: String(err && err.message || err).slice(0, 300) }));
      } catch (e) {}
      process.exit(1);
    }
  });
}

main();
