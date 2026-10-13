const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { loadMainHandlers } = require('./helpers.cjs');

// Builds a main.js context with scriptable dialog / net / shell / electron-updater.
function setup({ platform = 'linux', env = {}, packaged = true, version = '1.10.0', release, httpStatus = 200, buttons = [0, 0], updater } = {}) {
  const dialogs = [], opened = [], progress = [];
  let call = 0;
  const listeners = new Map();
  const net = {
    request: () => {
      const req = new EventEmitter();
      req.setHeader = () => {}; req.abort = () => {};
      req.end = () => setImmediate(() => {
        if (release === 'neterror') return req.emit('error', new Error('offline'));
        const res = Object.assign(Buffer.from(JSON.stringify(release || {})).toString() && (async function* () { yield JSON.stringify(release || {}); })(), { statusCode: httpStatus, setEncoding() {} });
        req.emit('response', res);
      });
      return req;
    }
  };
  const { context } = loadMainHandlers({
    electron: {
      app: { whenReady: () => ({ then() {} }), on() {}, quit() {}, exit() {}, getPath: () => __dirname, isPackaged: packaged, getVersion: () => version },
      dialog: { showMessageBox: async (...a) => { const o = a[a.length - 1]; dialogs.push(o); return { response: buttons[Math.min(call++, buttons.length - 1)] }; } },
      shell: { openExternal: url => { opened.push(url); } },
      ipcMain: { handle() {}, on: (n, f) => listeners.set(n, f) },
      net
    },
    modules: updater ? { 'electron-updater': { autoUpdater: updater } } : undefined
  });
  context.process.platform = platform;
  context.process.env = { ...env };
  return { context, dialogs, opened, progress, setUnsaved: v => listeners.get('set-unsaved')({}, v) };
}
const fakeUpdater = (available = true) => {
  const u = new EventEmitter();
  u.calls = [];
  u.checkForUpdates = async () => ({ isUpdateAvailable: available, updateInfo: { version: '1.11.0' } });
  u.downloadUpdate = async () => { u.calls.push('download'); };
  u.quitAndInstall = () => { u.calls.push('install'); };
  return u;
};

test('isNewerVersion compares major.minor.patch numerically', () => {
  const { context: c } = setup();
  assert.equal(c.isNewerVersion('1.10.1', '1.10.0'), true);
  assert.equal(c.isNewerVersion('1.11.0', '1.10.9'), true);
  assert.equal(c.isNewerVersion('2.0.0', '1.99.99'), true);
  assert.equal(c.isNewerVersion('1.10.0', '1.10.0'), false);
  assert.equal(c.isNewerVersion('1.9.9', '1.10.0'), false);
  assert.equal(c.isNewerVersion('1.11.0-beta.1', '1.10.0'), true);
  assert.equal(c.isNewerVersion('1.10.0-beta.1', '1.10.0'), false);
  assert.equal(c.isNewerVersion('garbage', '1.10.0'), false);
  assert.equal(c.isNewerVersion('1.11.0', 'garbage'), false);
  assert.equal(c.isNewerVersion('', '1.10.0'), false);
});

test('canSelfUpdate only for packaged Windows installer and Linux AppImage', () => {
  const can = o => setup(o).context.canSelfUpdate();
  assert.equal(can({ packaged: false, platform: 'win32' }), false);
  assert.equal(can({ platform: 'win32' }), true);
  assert.equal(can({ platform: 'win32', env: { PORTABLE_EXECUTABLE_FILE: 'x.exe' } }), false);
  assert.equal(can({ platform: 'linux', env: { APPIMAGE: '/a.AppImage' } }), true);
  assert.equal(can({ platform: 'linux' }), false);
  assert.equal(can({ platform: 'darwin' }), false);
});

const rel = (tag, url) => ({ tag_name: tag, html_url: url });
const GOOD = 'https://github.com/arie-s/pagewise/releases/tag/v1.11.0';

test('fallback: newer release offers the release page and opens html_url', async () => {
  const s = setup({ release: rel('v1.11.0', GOOD), buttons: [0] });
  await s.context.checkForUpdates({ quiet: true });
  assert.equal(s.dialogs.length, 1);
  assert.match(s.dialogs[0].message, /1\.11\.0 is available \(you have 1\.10\.0\)/);
  assert.deepEqual(s.opened, [GOOD]);
});

test('fallback: Later does not open anything', async () => {
  const s = setup({ release: rel('v1.11.0', GOOD), buttons: [1] });
  await s.context.checkForUpdates({ quiet: false });
  assert.deepEqual(s.opened, []);
  assert.equal(s.dialogs.length, 1);
});

test('fallback: a foreign html_url opens the releases/latest page instead', async () => {
  for (const bad of ['https://evil.example/', 'https://github.com/arie-s/pagewise-evil/releases/x', undefined]) {
    const s = setup({ release: rel('v1.11.0', bad), buttons: [0] });
    await s.context.checkForUpdates({ quiet: false });
    assert.deepEqual(s.opened, ['https://github.com/arie-s/pagewise/releases/latest']);
  }
});

test('fallback: same version is silent when quiet, "up to date" otherwise', async () => {
  let s = setup({ release: rel('v1.10.0', GOOD) });
  await s.context.checkForUpdates({ quiet: true });
  assert.equal(s.dialogs.length, 0);
  s = setup({ release: rel('v1.10.0', GOOD) });
  await s.context.checkForUpdates({ quiet: false });
  assert.equal(s.dialogs.length, 1);
  assert.match(s.dialogs[0].message, /up to date/);
  assert.equal(s.dialogs[0].detail, 'Pagewise v1.10.0 is the latest version.');
});

test('fallback: errors are silent when quiet and a warning otherwise, and the guard is released', async () => {
  let s = setup({ release: {}, httpStatus: 500 });
  await s.context.checkForUpdates({ quiet: true });
  assert.equal(s.dialogs.length, 0);
  s = setup({ release: 'neterror' });
  await s.context.checkForUpdates({ quiet: false });
  assert.equal(s.dialogs[0].type, 'warning');
  assert.match(s.dialogs[0].detail, /offline/);
  await s.context.checkForUpdates({ quiet: false });
  assert.equal(s.dialogs.length, 2);
  assert.match(s.dialogs[1].message, /Couldn't check/);
});

test('overlapping checks: non-quiet says so, quiet returns silently', async () => {
  const s = setup({ release: rel('v1.10.0', GOOD) });
  const first = s.context.checkForUpdates({ quiet: false });
  await s.context.checkForUpdates({ quiet: true });
  assert.equal(s.dialogs.length, 0);
  await s.context.checkForUpdates({ quiet: false });
  assert.match(s.dialogs[0].message, /Already checking/);
  await first;
});

test('self-update with unsaved changes downloads but never calls quitAndInstall', async () => {
  const u = fakeUpdater();
  const s = setup({ env: { APPIMAGE: '/a.AppImage' }, updater: u, buttons: [0] });
  s.setUnsaved(true);
  await s.context.checkForUpdates({ quiet: false });
  assert.deepEqual(u.calls, ['download']);
  assert.match(s.dialogs.at(-1).detail, /installs the update when you quit/);
  assert.equal(u.autoDownload, false);
  assert.equal(u.autoInstallOnAppQuit, true);
});

test('self-update without unsaved changes installs on "Restart Now" only', async () => {
  let u = fakeUpdater();
  let s = setup({ env: { APPIMAGE: '/a.AppImage' }, updater: u, buttons: [0, 0] });
  await s.context.checkForUpdates({ quiet: false });
  assert.deepEqual(u.calls, ['download', 'install']);
  u = fakeUpdater();
  s = setup({ env: { APPIMAGE: '/a.AppImage' }, updater: u, buttons: [0, 1] });
  await s.context.checkForUpdates({ quiet: false });
  assert.deepEqual(u.calls, ['download']);
});

test('self-update: declining the download, or no update, never downloads', async () => {
  let u = fakeUpdater();
  let s = setup({ env: { APPIMAGE: '/a.AppImage' }, updater: u, buttons: [1] });
  await s.context.checkForUpdates({ quiet: false });
  assert.deepEqual(u.calls, []);
  u = fakeUpdater(false);
  s = setup({ env: { APPIMAGE: '/a.AppImage' }, updater: u });
  await s.context.checkForUpdates({ quiet: true });
  assert.equal(s.dialogs.length, 0);
});

test('an installer build without update info falls back to the release page check', async () => {
  const u = fakeUpdater(); u.checkForUpdates = async () => null;
  const s = setup({ platform: 'win32', updater: u, release: rel('v1.11.0', GOOD), buttons: [0] });
  await s.context.checkForUpdates({ quiet: false });
  assert.equal(s.dialogs.length, 1);
  assert.match(s.dialogs[0].message, /1\.11\.0 is available/);
  assert.deepEqual(s.opened, [GOOD]);
});
