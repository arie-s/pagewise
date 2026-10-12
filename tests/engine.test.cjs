const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadMainHandlers } = require('./helpers.cjs');

function withUserData(t) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pagewise-engine-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const app = { whenReady: () => ({ then: () => {} }), on: () => {}, quit: () => {}, exit: () => {}, getPath: () => userData };
  return { userData, ...loadMainHandlers({ electron: { app } }) };
}

test('engine-remove deletes the engine folder and reports the space freed', async t => {
  const { userData, handlers } = withUserData(t);
  const engineDir = path.join(userData, 'ocr-engine');
  fs.mkdirSync(path.join(engineDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(engineDir, 'dots-ocr-text-Q8_0.gguf'), Buffer.alloc(3000));
  fs.writeFileSync(path.join(engineDir, 'lib', 'libggml.so'), Buffer.alloc(1000));
  fs.writeFileSync(path.join(userData, 'settings.json'), '{}');

  const result = await handlers.get('engine-remove')();
  assert.equal(result.success, true, result.error);
  assert.equal(result.freedBytes, 4000);
  assert.equal(fs.existsSync(engineDir), false, 'engine folder removed');
  assert.equal(fs.existsSync(path.join(userData, 'settings.json')), true, 'settings are kept');
  assert.equal((await handlers.get('engine-status')()).installed, false);
});

test('engine-remove succeeds when nothing is installed', async t => {
  const { handlers } = withUserData(t);
  const result = await handlers.get('engine-remove')();
  assert.deepEqual({ success: result.success, freedBytes: result.freedBytes }, { success: true, freedBytes: 0 });
});

// Asset names from llama.cpp release b11558.
const ASSETS = [
  'cudart-llama-b11558-bin-ubuntu-cuda-12.8-x64.tar.gz', 'llama-b11558-bin-ubuntu-cuda-13.4-x64.tar.gz',
  'llama-b11558-bin-ubuntu-rocm-10.0-x64.tar.gz', 'llama-b11558-bin-ubuntu-vulkan-arm64.tar.gz',
  'llama-b11558-bin-ubuntu-vulkan-x64.tar.gz', 'llama-b11558-bin-ubuntu-x64.tar.gz', 'llama-b11558-bin-ubuntu-arm64.tar.gz',
  'llama-b11558-bin-macos-arm64.tar.gz', 'llama-b11558-bin-macos-x64.tar.gz',
  'llama-b11558-bin-win-cpu-arm64.zip', 'llama-b11558-bin-win-cpu-x64.zip', 'llama-b11558-bin-win-cuda-12.4-x64.zip',
  'llama-b11558-bin-win-vulkan-arm64.zip', 'llama-b11558-bin-win-vulkan-x64.zip'
];

test('engine asset pattern picks exactly one build per platform and GPU choice', t => {
  const { context } = withUserData(t);
  const pick = (...a) => ASSETS.filter(n => context.engineAssetPattern(...a).test(n));
  assert.deepEqual(pick('linux', 'x64', true), ['llama-b11558-bin-ubuntu-vulkan-x64.tar.gz']);
  assert.deepEqual(pick('linux', 'x64', false), ['llama-b11558-bin-ubuntu-x64.tar.gz']);
  assert.deepEqual(pick('win32', 'x64', true), ['llama-b11558-bin-win-vulkan-x64.zip']);
  assert.deepEqual(pick('win32', 'x64', false), ['llama-b11558-bin-win-cpu-x64.zip']);
  assert.deepEqual(pick('darwin', 'arm64', false), ['llama-b11558-bin-macos-arm64.tar.gz']);
  assert.deepEqual(pick('darwin', 'x64', false), ['llama-b11558-bin-macos-x64.tar.gz']);
});

test('engine device list keeps real GPUs and ignores software renderers', t => {
  const { context } = withUserData(t);
  const gpu = 'ggml_vulkan: Found 2 Vulkan devices:\nAvailable devices:\n  Vulkan0: NVIDIA GeForce RTX 5060 Ti (15849 MiB, 8400 MiB free)\n  Vulkan1: llvmpipe (LLVM 19.1.1, 256 bits) (32000 MiB, 32000 MiB free)\n';
  assert.deepEqual([...context.parseEngineDevices(gpu)], ['NVIDIA GeForce RTX 5060 Ti']);
  const none = '0.00.014.898 E ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected\nAvailable devices:\n  (none)\n';
  assert.deepEqual([...context.parseEngineDevices(none)], []);
  assert.deepEqual([...context.parseEngineDevices('Available devices:\n  MTL0: Apple M2 Pro (21845 MiB, 21845 MiB free)\n')], ['Apple M2 Pro']);
});

test('clearing the engine binary keeps downloaded models', t => {
  const { userData, context } = withUserData(t);
  const dir = path.join(userData, 'ocr-engine');
  fs.mkdirSync(path.join(dir, 'build', 'bin'), { recursive: true });
  for (const f of ['llama-server', 'libggml-vulkan.so', 'device.txt', 'model.gguf', 'mmproj.gguf']) fs.writeFileSync(path.join(dir, f), 'x');
  context.clearEngineBinary(context.enginePaths());
  assert.deepEqual(fs.readdirSync(dir).sort(), ['mmproj.gguf', 'model.gguf']);
});

// Fake electron net: the HF tree listing returns `tree`, /health returns `health`, model downloads fail with 404.
function fakeNet(urls, { tree = [], health = 0 } = {}) {
  return {
    request(opts) {
      const url = typeof opts === 'string' ? opts : opts.url;
      urls.push(url);
      let onResponse;
      const req = {
        setHeader() {},
        on(ev, fn) { if (ev === 'response') onResponse = fn; return req; },
        end() {
          setImmediate(() => {
            if (!onResponse) return;
            const body = url.includes('/tree/main') ? JSON.stringify(tree) : '';
            const res = { statusCode: url.includes('/health') ? health : url.includes('/tree/main') ? 200 : 404, headers: {}, setEncoding() {}, resume() {}, on() {}, async *[Symbol.asyncIterator]() { yield body; } };
            onResponse(res);
          });
        }
      };
      return req;
    }
  };
}

const BIN = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

function withEngine(t, netOpts, { device = true, models = true } = {}) {
  const urls = [];
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pagewise-engine-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const app = { whenReady: () => ({ then: () => {} }), on: () => {}, quit: () => {}, exit: () => {}, getPath: () => userData };
  const loaded = loadMainHandlers({ electron: { app, net: fakeNet(urls, netOpts) } });
  const dir = path.join(userData, 'ocr-engine');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, BIN), 'x');
  if (device) fs.writeFileSync(path.join(dir, 'device.txt'), 'CPU');
  if (models) {
    fs.writeFileSync(path.join(dir, 'dots-ocr-mmproj.gguf'), Buffer.alloc(10));
    fs.writeFileSync(path.join(dir, 'dots-ocr-text-Q8_0.gguf'), Buffer.alloc(20));
  }
  return { urls, dir, ...loaded };
}

const TREE = [{ path: 'mmproj-F16.gguf', lfs: { size: 10 }, size: 134 }, { path: 'dots.ocr-Q8_0.gguf', lfs: { size: 20 } }, { path: 'README.md', size: 5 }];

test('engine-install skips model downloads when files already match the listed sizes', async t => {
  const { urls, handlers } = withEngine(t, { tree: TREE });
  const result = await handlers.get('engine-install')({}, {});
  assert.equal(result.success, true, result.error);
  assert.deepEqual(urls.filter(u => u.includes('/resolve/')), []);
});

test('engine-install replaces an older binary that has no device.txt and keeps the models', async t => {
  const { urls, dir, handlers } = withEngine(t, { tree: TREE }, { device: false });
  const result = await handlers.get('engine-install')({}, {});
  assert.equal(result.success, false); // the fake network has no llama.cpp release to download
  assert.ok(urls.some(u => u.includes('api.github.com/repos/ggml-org/llama.cpp/releases')), 'binary step ran');
  assert.equal(fs.existsSync(path.join(dir, BIN)), false, 'old binary cleared');
  assert.equal(fs.existsSync(path.join(dir, 'dots-ocr-text-Q8_0.gguf')), true, 'models kept');
});

test('engine-install re-downloads a model whose size differs from the listing', async t => {
  const { urls, dir, handlers } = withEngine(t, { tree: TREE });
  fs.writeFileSync(path.join(dir, 'dots-ocr-text-Q8_0.gguf'), Buffer.alloc(7));
  const result = await handlers.get('engine-install')({}, {});
  assert.equal(result.success, false);
  assert.match(result.error, /HTTP 404/);
  const resolved = urls.filter(u => u.includes('/resolve/'));
  assert.equal(resolved.length, 1);
  assert.ok(resolved[0].endsWith('/dots.ocr-Q8_0.gguf'));
});

test('engine-status needs device.txt, so an older CPU-only install counts as not installed', async t => {
  const old = withEngine(t, {}, { device: false });
  assert.equal((await old.handlers.get('engine-status')()).installed, false);
  const current = withEngine(t, {});
  assert.equal((await current.handlers.get('engine-status')()).installed, true);
});

test('engine-start reuses a healthy server instead of spawning another', async t => {
  const cp = require('node:child_process');
  const realSpawn = cp.spawn;
  let spawned = 0;
  cp.spawn = () => { spawned++; throw new Error('spawn should not be called'); };
  t.after(() => { cp.spawn = realSpawn; });
  const { handlers } = withEngine(t, { health: 200 });
  const result = await handlers.get('engine-start')();
  assert.equal(result.success, true, result.error);
  assert.equal(result.running, true);
  assert.equal(spawned, 0);
});

// Fake engine: spawn returns controllable processes; /health is 200 while one is alive; completions follow `replies`.
function fakeEngine(t, replies) {
  const spawns = [], cp = require('node:child_process'), realSpawn = cp.spawn;
  cp.spawn = (bin, args) => { const p = { pid: 4242 + spawns.length, exitCode: null, signalCode: null, kill() { this.signalCode = 'SIGTERM'; } }; spawns.push({ args, p }); return p; };
  t.after(() => { cp.spawn = realSpawn; });
  const alive = () => spawns.some(s => s.p.exitCode === null && s.p.signalCode === null);
  const net = { request(opts) {
    const url = typeof opts === 'string' ? opts : opts.url;
    let onResponse, onError;
    const req = { setHeader() {}, on(ev, fn) { if (ev === 'response') onResponse = fn; if (ev === 'error') onError = fn; return req; },
      end() { setImmediate(() => {
        if (url.endsWith('/health')) return onResponse({ statusCode: alive() ? 200 : 0, resume() {} });
        const r = replies.shift();
        if (r instanceof Error) return onError(r);
        const handlers = {};
        onResponse({ statusCode: 200, setEncoding() {}, on(ev, fn) { handlers[ev] = fn; } });
        handlers.data(JSON.stringify(r)); handlers.end();
      }); } };
    return req;
  } };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pagewise-engine-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  const dir = path.join(userData, 'ocr-engine'); fs.mkdirSync(dir);
  for (const f of [BIN, 'device.txt', 'dots-ocr-text-Q8_0.gguf', 'dots-ocr-mmproj.gguf']) fs.writeFileSync(path.join(dir, f), 'x');
  const app = { whenReady: () => ({ then: () => {} }), on: () => {}, quit: () => {}, exit: () => {}, getPath: () => userData };
  return { spawns, ...loadMainHandlers({ electron: { app, net } }) };
}
const ok = text => ({ choices: [{ message: { content: text } }] });

test('a GPU out-of-memory failure restarts the engine on the CPU and retries the page', async t => {
  const { spawns, context, handlers } = fakeEngine(t, [{ error: { message: 'failed to process mtmd chunk' } }, ok('page text')]);
  const r = await context.smartExtract('AAAA');
  assert.equal(r.content, 'page text');
  assert.equal(r.cpuFallback, true);
  assert.equal(spawns.length, 2);
  assert.ok(spawns[0].args.join(' ').includes('-ngl 999'));
  assert.ok(spawns[1].args.join(' ').includes('-ngl 0 --device none --no-mmproj-offload'));
  assert.match((await handlers.get('engine-status')()).device, /^CPU/);
  await handlers.get('engine-stop')();
  assert.doesNotMatch(String((await handlers.get('engine-status')()).device), /^CPU/, 'stopping from the UI goes back to the GPU');
});

test('an engine that dies mid-request also falls back to the CPU', async t => {
  const { spawns, context } = fakeEngine(t, [Object.assign(new Error('net::ERR_EMPTY_RESPONSE')), ok('x')]);
  assert.equal((await context.smartExtract('AAAA')).content, 'x');
  assert.equal(spawns.length, 2);
});

test('other engine errors do not trigger the CPU fallback', async t => {
  const { spawns, context } = fakeEngine(t, [{ error: { message: 'the request exceeds the available context size' } }]);
  await assert.rejects(context.smartExtract('AAAA'), /context size/);
  assert.equal(spawns.length, 1);
});

test('a crashed engine counts as stopped and is restarted on the next request', async t => {
  const { spawns, context, handlers } = fakeEngine(t, [ok('a'), ok('b')]);
  await context.smartExtract('AAAA');
  spawns[0].p.exitCode = 139;
  assert.equal((await handlers.get('engine-status')()).running, false);
  assert.equal((await context.smartExtract('AAAA')).content, 'b');
  assert.equal(spawns.length, 2);
  assert.ok(spawns[1].args.join(' ').includes('-ngl 999'), 'a crash alone does not switch to CPU');
});
