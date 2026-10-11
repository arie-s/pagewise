const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadMainHandlers } = require('./helpers.cjs');

function launchWithData(t, directories) {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'local-pdf-desk-'));
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
  let userData = path.join(appData, 'Local PDF Desk');
  fs.mkdirSync(userData);
  for (const [name, entry] of directories) {
    const dir = path.join(appData, name);
    fs.mkdirSync(dir, { recursive: true });
    if (entry === 'settings.json') fs.writeFileSync(path.join(dir, entry), '{}');
    else fs.mkdirSync(path.join(dir, entry));
  }
  loadMainHandlers({ electron: { app: {
    getPath: name => name === 'userData' ? userData : appData,
    setPath: (name, value) => { assert.equal(name, 'userData'); userData = value; },
    whenReady: () => ({ then() {} }), on() {}, quit() {}, exit() {}
  } } });
  return { appData, userData };
}

test('rename reuses packaged-app settings even if the new data directory already exists', t => {
  const { appData, userData } = launchWithData(t, [['PDF Studio Pro', 'settings.json']]);
  assert.equal(userData, path.join(appData, 'PDF Studio Pro'));
});

test('rename reuses source-app model downloads without requiring a settings file', t => {
  const { appData, userData } = launchWithData(t, [['pdf-studio-pro', 'ocr-engine']]);
  assert.equal(userData, path.join(appData, 'pdf-studio-pro'));
});

test('rename keeps existing data for the new name instead of reverting to legacy data', t => {
  const { appData, userData } = launchWithData(t, [
    ['Local PDF Desk', 'settings.json'], ['PDF Studio Pro', 'settings.json']
  ]);
  assert.equal(userData, path.join(appData, 'Local PDF Desk'));
});

test('fresh installs keep the new data path', t => {
  const { appData, userData } = launchWithData(t, []);
  assert.equal(userData, path.join(appData, 'Local PDF Desk'));
});
