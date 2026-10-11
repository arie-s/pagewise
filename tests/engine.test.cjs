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
