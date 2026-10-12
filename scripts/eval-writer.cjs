#!/usr/bin/env node
// Benchmark a writing model with the exact prompts, guards and checks Pagewise uses for AI form suggestions.
//   node scripts/eval-writer.cjs --model path/to/model.gguf [--bin path/to/llama-server] [--gpu]
//   node scripts/eval-writer.cjs --url http://127.0.0.1:8733     (a server that is already running)
// Prints one line per case and a score summary; exit code 0 regardless (it's a measurement, not a test).
const fs = require('fs'), path = require('path'), os = require('os'), { spawn } = require('child_process');
const { loadMainHandlers } = require('../tests/helpers.cjs');
const { context } = loadMainHandlers();
// top-level consts in main.js aren't context properties; read them through the context
const m = new Proxy(context, { get: (c, k) => k in c ? c[k] : require('vm').runInContext(String(k), c) });
const evalSet = JSON.parse(fs.readFileSync(path.join(__dirname, '../tests/fixtures/writer-eval.json'), 'utf8'));

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i < 0 ? def : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function defaultBin() {
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const base = process.platform === 'win32' ? process.env.APPDATA : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support') : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return ['Pagewise', 'pdf-studio-pro', 'PDF Studio Pro'].map(d => path.join(base, d, 'ocr-engine', exe)).find(f => fs.existsSync(f));
}

async function chat(url, body) {
  const full = { ...body, temperature: 0, chat_template_kwargs: { enable_thinking: false } };
  const r = await (await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(full) })).json();
  if (r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return String(r.choices?.[0]?.message?.content || '').trim();
}

(async () => {
  let url = arg('url'), proc = null;
  if (!url) {
    const model = arg('model'), bin = arg('bin', defaultBin());
    if (!model || !bin) { console.error('usage: eval-writer.cjs --model file.gguf [--bin llama-server] [--gpu] | --url http://host:port'); process.exit(2); }
    const port = 8741; url = 'http://127.0.0.1:' + port;
    proc = spawn(bin, ['-m', model, '--host', '127.0.0.1', '--port', String(port), ...(arg('gpu') ? ['-ngl', '999'] : ['-ngl', '0', '--device', 'none']), '-c', '8192', '-np', '1', '--jinja', '--no-webui'], { stdio: 'ignore', env: { ...process.env, LD_LIBRARY_PATH: path.dirname(bin) } });
    for (let i = 0; i < 180; i++) { await sleep(1000); try { if ((await fetch(url + '/health')).ok) break; } catch (e) {} if (proc.exitCode !== null) { console.error('llama-server exited'); process.exit(1); } }
  }
  try {
    const t0 = Date.now(), blocked = l => m.instructionShaped(l), labels = evalSet.labels.map(l => l[0]).filter(l => !blocked(l));
    const keys = m.parseMapping(await chat(url, { messages: m.mapLabelsPrompt(labels), max_tokens: 40 + 12 * labels.length, response_format: { type: 'json_schema', json_schema: { name: 'field_keys', schema: m.mapSchema(labels.length) } } }), labels.length);
    const mapMs = Date.now() - t0;
    let raw = 0, final = 0, wrongFilled = 0;
    console.log('Label mapping');
    let k = 0;
    evalSet.labels.forEach(([label, want]) => {
      const ok = [].concat(want), got = blocked(label) ? 'blocked' : keys[k++], kept = !['none', 'answer', 'blocked'].includes(got) && m.aiKeyAllowed(label, got) ? got : 'none';
      raw += ok.includes(got); final += ok.includes(kept); if (kept !== 'none' && !ok.includes(kept)) wrongFilled++;
      console.log(`  ${ok.includes(kept) ? 'ok  ' : 'MISS'} ${label.slice(0, 50).padEnd(50)} model=${got.padEnd(12)} kept=${kept.padEnd(12)} want=${ok.join('|')}`);
    });
    const profile = m.profileText(evalSet.profile);
    let good = 0, refusedOk = 0, unsupported = 0;
    const qMs = Date.now();
    console.log('Drafted answers');
    for (const c of evalSet.questions) {
      if (blocked(c.q)) { const pass = !!c.none; good += pass; console.log(`  ${pass ? 'ok  ' : 'MISS'} ${c.q.slice(0, 50).padEnd(50)} -> (blocked: instructions in the label, not sent to the model)`); continue; }
      const out = await chat(url, { messages: [{ role: 'system', content: m.ANSWER_SYSTEM }, { role: 'user', content: `Profile:\n${profile}\n\nQuestion: ${c.q}` }], max_tokens: 200 });
      const chk = m.checkAnswer(out, profile), low = out.toLowerCase();
      const pass = c.notInProfile ? !!chk.notInProfile
        : !chk.notInProfile && c.any.some(k => low.includes(k.toLowerCase())) && !(c.none || []).some(k => out.includes(k));
      good += pass; if (c.notInProfile && pass) refusedOk++; if (!chk.notInProfile && chk.unsupported.length) unsupported++;
      console.log(`  ${pass ? 'ok  ' : 'MISS'} ${c.q.slice(0, 50).padEnd(50)} -> ${out.replace(/\s+/g, ' ').slice(0, 90)}${chk.unsupported?.length ? '   [unsupported: ' + chk.unsupported.join(', ') + ']' : ''}`);
    }
    const n = evalSet.labels.length, q = evalSet.questions.length, nNot = evalSet.questions.filter(c => c.notInProfile).length;
    console.log(`\nLabels: ${final}/${n} after the guard (${raw}/${n} raw model), ${wrongFilled} wrong values offered; ${(mapMs / 1000).toFixed(1)}s`);
    console.log(`Answers: ${good}/${q} (honest "not in profile" ${refusedOk}/${nNot}); ${unsupported} flagged with unsupported claims; ${((Date.now() - qMs) / 1000).toFixed(1)}s`);
  } finally { if (proc) proc.kill(); }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
