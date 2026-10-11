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
