#!/usr/bin/env node
// Benchmark the Ask assistant with the exact prompts, retrieval, quote checks and menu table Pagewise uses.
//   node scripts/eval-assistant.cjs --model path/to/model.gguf [--mmproj path/to/mmproj.gguf] [--bin path/to/llama-server]      the built-in model, started here (with --mmproj it also gets the image cases)
//   node scripts/eval-assistant.cjs --url http://127.0.0.1:8001 --model-id ID [--reasoning server|off] [--n-ctx N]   a server of your own
//   --only help|oos|page|image|document   run one category
// Prints one line per case, then a summary per category with median and p90 latency. Exit code 0 regardless (it's a measurement, not a test).
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm'), { spawn } = require('child_process');
const { loadMainHandlers, loadRendererFunctions } = require('../tests/helpers.cjs');
const { context } = loadMainHandlers();
const m = new Proxy(context, { get: (c, k) => k in c ? c[k] : vm.runInContext(String(k), c) });
const { functions: { pageSearchText } } = loadRendererFunctions(['pageSearchText']);
const evalSet = JSON.parse(fs.readFileSync(path.join(__dirname, '../tests/fixtures/assistant-eval.json'), 'utf8'));
const root = path.join(__dirname, '..');

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i < 0 ? def : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function defaultBin() {
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const base = process.platform === 'win32' ? process.env.APPDATA : process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support') : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return ['Pagewise', 'pdf-studio-pro', 'PDF Studio Pro'].map(d => path.join(base, d, 'ocr-engine', exe)).find(f => fs.existsSync(f));
}
const median = a => a.length ? [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : 0;
const p90 = a => a.length ? [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.ceil(0.9 * a.length) - 1)] : 0;
const has = (text, list) => (list || []).some(k => String(text).toLowerCase().includes(String(k).toLowerCase()));

// One chat request, as the app sends it (without streaming); returns the reply text
async function chat(cfg, url, body) {
  const send = async b => {
    const res = await fetch(url + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m.modelBody(cfg, b)), signal: AbortSignal.timeout(900000) });
    const text = await res.text();
    return { status: res.status, text };
  };
  let r = await send(body);
  if (r.status === 400 && body.response_format && /response_format|schema|grammar/i.test(r.text)) { const { response_format, ...rest } = body; r = await send(rest); }
  const j = JSON.parse(r.text);
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return String(j.choices?.[0]?.message?.content || '');
}

async function pdfPages(file, only) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(root, file))), verbosity: 0 }).promise, pages = [];
  for (let n = 1; n <= doc.numPages; n++) if (!only || only.includes(n)) pages.push([n, pageSearchText((await (await doc.getPage(n)).getTextContent()).items).text]);
  return pages;
}
async function sourceText(src) {
  const [kind, name] = src.split(':');
  if (src === 'none') return { text: '', page: 1 };
  if (kind === 'syn') return { text: evalSet.synthetic[name], page: 1 };
  if (kind === 'text') return { text: (await pdfPages(`tests/fixtures/text/${name}.pdf`))[0][1], page: 1 };
  if (name === 'all') return { text: (await pdfPages('tests/fixtures/forms/fw9.pdf')).map(([n, t]) => `[Page ${n}]\n${t.trim()}`).join('\n\n'), page: 1 };
  return { text: (await pdfPages('tests/fixtures/forms/fw9.pdf', [Number(name)]))[0][1], page: Number(name) };
}

(async () => {
  let url = arg('url'), proc = null, cfg;
  const mmprojArg = arg('mmproj'), mmproj = typeof mmprojArg === 'string' ? mmprojArg : null;
  const modelId = arg('model-id');
  if (modelId) cfg = { kind: 'custom', url, model: modelId, reasoning: arg('reasoning', 'server') === 'off' ? 'off' : 'server' };
  else {
    cfg = { kind: 'builtin' };
    if (!url) {
      const model = arg('model'), bin = arg('bin', defaultBin());
      if (!model || !bin) { console.error('usage: eval-assistant.cjs --model file.gguf [--mmproj file.gguf] [--bin llama-server] | --url http://host:port --model-id ID [--reasoning server|off] [--n-ctx N]'); process.exit(2); }
      const port = 8742; url = 'http://127.0.0.1:' + port;
      proc = spawn(bin, ['-m', model, ...(mmproj ? ['--mmproj', mmproj] : []), '--host', '127.0.0.1', '--port', String(port), '-ngl', '0', '--device', 'none', '-c', '8192', '-np', '1', '--jinja', '--no-webui'], { stdio: 'ignore', env: { ...process.env, LD_LIBRARY_PATH: path.dirname(bin) } });
      for (let i = 0; i < 180; i++) { await sleep(1000); try { if ((await fetch(url + '/health')).ok) break; } catch (e) { /* not up yet */ } if (proc.exitCode !== null) { console.error('llama-server exited'); process.exit(1); } }
    }
  }
  url = url.replace(/\/+$/, '');
  if (cfg.kind === 'custom') cfg.url = url;
  let nCtx = Number(arg('n-ctx', 0));
  if (cfg.kind === 'custom' && !nCtx) { try { const j = await (await fetch(url + '/props')).json(); nCtx = j.default_generation_settings?.n_ctx || j.n_ctx || 0; } catch (e) { /* no props */ } }
  const bud = cfg.kind === 'custom' ? m.assistantBudget(nCtx) : { nCtx: 8192, pageTokens: 2500, helpTokens: 1200 };
  console.log(`Model: ${cfg.kind === 'custom' ? cfg.model + ' at ' + url + ' (reasoning ' + cfg.reasoning + ')' : 'built-in ' + path.basename(String(arg('model', 'model'))) + (mmproj ? ' + ' + path.basename(mmproj) : '') + ', CPU'}; context ${bud.nCtx}, document budget ${bud.pageTokens} tokens, guide budget ${bud.helpTokens} tokens`);
  try {
    if (cfg.kind === 'custom') { process.stdout.write('Warm-up (the model may be loading)... '); const t = Date.now(); await chat(cfg, url, { messages: [{ role: 'user', content: 'Hi' }], max_tokens: 4 }).catch(e => console.log('failed: ' + e.message)); console.log(((Date.now() - t) / 1000).toFixed(1) + ' s'); }
    const table = m.buildMenuTable(), only = arg('only'), summary = {};
    const record = (cat, pass, ms) => { (summary[cat] = summary[cat] || { n: 0, pass: 0, ms: [], extra: {} }); const s = summary[cat]; s.n++; s.pass += pass ? 1 : 0; s.ms.push(ms); return s; };
    const bump = (cat, key, v = 1) => { summary[cat].extra[key] = (summary[cat].extra[key] || 0) + v; };
    const line = (ok, ms, label, note) => console.log(`  ${ok ? 'ok  ' : 'MISS'} ${(ms / 1000).toFixed(1).padStart(6)}s  ${label.slice(0, 52).padEnd(52)} ${String(note).replace(/\s+/g, ' ').slice(0, 130)}`);

    const helpAnswer = async q => {
      const req = { mode: 'help', question: q, history: [] }, plan = m.helpPlan(req, cfg, bud);
      if (plan.early) return { raw: plan.early.answer, result: plan.early, ms: 0 };
      const t = Date.now(), raw = await chat(cfg, url, plan.body);
      return { raw, result: m.helpResult(raw, cfg, table), ms: Date.now() - t };
    };
    if (!only || only === 'help') {
      console.log('Help (' + evalSet.help.length + ')');
      for (const c of evalSet.help) {
        let r; try { r = await helpAnswer(c.q); } catch (e) { record('help', false, 0); line(false, 0, c.q, 'ERROR ' + e.message); continue; }
        const { answer, actions } = r.result, norm = m.answerForMenus(answer);
        const keywordOk = has(answer, c.expectAny), pathMention = !c.expectPath || actions.some(a => a.path === c.expectPath) || m.menuKeys(c.expectPath).some(k => norm.includes(k));
        const actionOk = !c.expectPath || actions.some(a => a.path === c.expectPath), bad = m.invalidMenuPaths(answer, table), pass = keywordOk && pathMention;
        const s = record('help', pass, r.ms); if (c.expectPath) { bump('help', 'withPath'); if (actionOk) bump('help', 'actionOk'); } if (bad.length) bump('help', 'hallucinated');
        line(pass, r.ms, c.q, `${c.expectPath ? (actionOk ? '[button ok] ' : '[no button] ') : ''}${bad.length ? '[INVALID ' + bad.join('; ') + '] ' : ''}${answer}`);
      }
    }
    if (!only || only === 'oos') {
      console.log('Out of scope (' + evalSet.outOfScope.length + ')');
      for (const q of evalSet.outOfScope) {
        let r; try { r = await helpAnswer(q); } catch (e) { record('oos', false, 0); line(false, 0, q, 'ERROR ' + e.message); continue; }
        const { answer, actions } = r.result, bad = m.invalidMenuPaths(answer, table), refused = answer.replace(/[\s.]+$/, '') === m.ASSISTANT_NOT_FOUND.replace(/\.$/, ''), pass = refused || (!actions.length && !bad.length);
        record('oos', pass, r.ms); if (refused) bump('oos', 'refused'); if (bad.length) bump('oos', 'hallucinated');
        line(pass, r.ms, q, `${refused ? '[refused] ' : ''}${bad.length ? '[INVALID ' + bad.join('; ') + '] ' : ''}${answer}`);
      }
    }
    const pageCases = async (cat, title, cases, scope) => {
      console.log(title + ' (' + cases.length + ')');
      for (const c of cases) {
        const { text, page } = await sourceText(c.source), req = { mode: 'page', scope, question: c.question, text, page, history: [] };
        if (c.image) req.image = fs.readFileSync(path.join(root, c.image)).toString('base64');
        const plan = m.pagePlan(req, cfg, bud, table);
        if (plan.early) { line(false, 0, c.id, 'SKIPPED: ' + plan.early.answer); continue; }
        let res, ms, raw;
        const t = Date.now();
        try { raw = await chat(cfg, url, plan.body); res = m.pageResult(req, plan.text, plan.footer, raw, cfg); } catch (e) { record(cat, false, Date.now() - t); line(false, Date.now() - t, c.id, 'ERROR ' + e.message + ' | ' + String(raw || '').slice(0, 80)); continue; }
        ms = Date.now() - t;
        const ans = res.answer, quotesOk = !c.expectQuoteAny || res.quotes.some(q => has(q.text, [c.expectQuoteAny])), pageOk = !c.expectPage || res.quotes.some(q => q.page === c.expectPage && has(q.text, [c.expectQuoteAny]));
        let pass;
        if (c.type === 'notFound') pass = res.found === false;
        else if (c.type === 'injection') pass = !(c.forbid || []).some(f => new RegExp(f, 'i').test(ans)) && (res.found === false || has(ans, c.expectAnswerAny));
        else pass = res.found === true && has(ans, c.expectAnswerAny) && quotesOk && (!c.expectPage || pageOk);
        record(cat, pass, ms);
        if (c.type === 'answerable') { bump(cat, 'answerable'); if (res.found && has(ans, c.expectAnswerAny)) bump(cat, 'answerOk'); if (quotesOk) bump(cat, 'quoteOk'); }
        if (c.type === 'injection') { bump(cat, 'injection'); if (pass) bump(cat, 'injectionResisted'); }
        if (c.type === 'notFound') { bump(cat, 'notFound'); if (pass) bump(cat, 'notFoundOk'); }
        if (res.found && !res.quotes.length) bump(cat, 'unverified');
        line(pass, ms, `${c.id} [${c.type}]`, `found=${res.found} quotes=${res.quotes.length}${c.expectPage ? ' pages=' + res.quotes.map(q => q.page) : ''} | ${ans}`);
      }
    };
    if (!only || only === 'page') await pageCases('page', 'Page', evalSet.page, 'page');
    if (!only || only === 'image') {
      if (cfg.kind === 'builtin' && mmproj) { context.visionInstalled = () => true; await pageCases('image', 'Image', evalSet.image, 'page'); }
      else console.log('Image (' + evalSet.image.length + '): SKIPPED, needs the built-in model started with --mmproj');
    }
    if (!only || only === 'document') await pageCases('document', 'Whole document', evalSet.document, 'document');

    console.log('\nSummary');
    const names = { help: 'Help', oos: 'Out of scope', page: 'Page', image: 'Image', document: 'Whole document' };
    for (const [cat, s] of Object.entries(summary)) {
      const e = s.extra, extra = Object.entries(e).map(([k, v]) => `${k}=${v}`).join(' ');
      console.log(`  ${names[cat].padEnd(15)} ${s.pass}/${s.n} passed   latency median ${(median(s.ms) / 1000).toFixed(1)}s  p90 ${(p90(s.ms) / 1000).toFixed(1)}s   ${extra}`);
    }
  } finally { if (proc) proc.kill(); }
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
