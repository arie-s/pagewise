const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { root, loadMainHandlers } = require('./helpers.cjs');

const plain = x => JSON.parse(JSON.stringify(x)); // results come from the vm realm
function boot({ encrypt = true } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pagewise-details-'));
  const safeStorage = {
    isEncryptionAvailable: () => encrypt,
    encryptString: s => Buffer.from('ENC:' + Buffer.from(s).toString('hex')),
    decryptString: b => { const t = b.toString(); if (!t.startsWith('ENC:')) throw new Error('cannot decrypt'); return Buffer.from(t.slice(4), 'hex').toString(); }
  };
  const app = { whenReady: () => ({ then: () => {} }), on: () => {}, quit: () => {}, exit: () => {}, getPath: () => userData, setPath: () => {} };
  const { handlers, context } = loadMainHandlers({ electron: { app, safeStorage } });
  return { handlers, m: context, userData, file: path.join(userData, 'profiles.json'), oldFile: path.join(userData, 'my-details.json') };
}
const SPOUSE = { firstName: 'John', middleName: '', lastName: 'Roe', ssn: '987-65-4321', dateOfBirth: '03/04/1979', dateFormat: 'MM/DD/YYYY' };
const DETAILS = { firstName: 'Jane', middleName: 'quinn', lastName: 'Doe', email: 'jane@example.com', phone: '555-123-4567', street: '12 Elm St Apt 4', city: 'Springfield', state: 'IL', zip: '62704', country: 'USA', dateOfBirth: '01/02/1980', ssn: '123-45-6789', company: 'Acme Inc', jobTitle: 'Engineer', notes: '', dateFormat: 'MM/DD/YYYY' };

const LABELS = [
  // W-9
  ['Name of entity/individual. An entry is required.', 'fullName'],
  ['Name of entity/individual. An entry is required. (For a sole proprietor or disregarded entity, enter the owner\'s name on line 1, and enter the business/disregarded entity\'s name on line 2.)', 'fullName'],
  ['New address (no., street, apt. no., city or town, state, and ZIP code). If a P.O. box, see instructions.', 'fullAddress'],
  ['Your old address (no., street, apt. no., city or town, state, and ZIP code)', null],
  ['Daytime telephone number of person to contact (optional)', 'phone'],
  ['Business name/disregarded entity name, if different from above', null],
  ['Address (number, street, and apt. or suite no.) See instructions.', 'street'],
  ['City, state, and ZIP code', 'cityStateZip'],
  ['Requester\'s name and address (optional)', null],
  ['Social security number', 'ssn'],
  ['Employer identification number', null],
  // 8822
  ['Your name (first name, initial, and last name)', 'fullName'],
  ['Spouse\'s name (first name, initial, and last name)', 'spouse/fullName'],
  ['Your social security number', 'ssn'],
  ['Spouse\'s social security number', 'spouse/ssn'],
  ['Spouse\'s prior name(s)', null], ['Spouse\'s old address', null], ['Partnership', null],
  ['Name (first and last name of spouse)', null],
  ['Your prior name(s)', null],
  ['Your old address (no., street, apt. no., city or town, state, and ZIP code)', null],
  ['New address (no., street, apt. no., city or town, state, and ZIP code) (see instructions)', 'fullAddress'],
  ['Foreign country name', null],
  ['Daytime telephone number of person to contact (optional)', 'phone'],
  ['Your signature', null],
  ['Date', 'today'],
  ['Decedent\'s name', null],
  // generic
  ['First name', 'firstName'], ['Last Name', 'lastName'], ['Surname', 'lastName'], ['Middle initial', 'middleName'], ['Given name', 'firstName'],
  ['E-mail address', 'email'], ['Email', 'email'], ['Mobile', 'phone'], ['Phone number', 'phone'],
  ['Date of birth', 'dateOfBirth'], ['DOB', 'dateOfBirth'], ['Place of birth', null],
  ['ZIP', 'zip'], ['Postal code', 'zip'], ['Country', 'country'], ['City', 'city'], ['State', 'state'], ['Province', 'state'],
  ['Street address', 'street'], ['Website address', null],
  ['Company', 'company'], ['Organization', 'company'], ['Job title', 'jobTitle'], ['Title', 'jobTitle'], ['Occupation', 'jobTitle'],
  ['Username', null], ['File name', null], ['Company name', 'company'], ['Emergency contact phone', null],
  ['Full name', 'fullName'], ['Name', 'fullName'], ['Date signed', 'today'], ['Date of death', null], ['Employer name', null],
  ['Landlord\'s phone', null], ['Phone or email', null], ['', null], ['Field 3', null]
];
test('classifyLabel matches labels that ask for the user\'s own details and skips everything else', () => {
  assert.ok(LABELS.length >= 40);
  const want = k => !k ? null : k.includes('/') ? { who: k.split('/')[0], key: k.split('/')[1] } : { who: 'self', key: k };
  for (const [label, key] of LABELS) assert.deepEqual(plain(app.m.classifyLabel(label)), want(key), JSON.stringify(label));
});
const app = boot();

const NOW = new Date(2026, 9, 5); // 5 Oct 2026, local time
const F = (id, label, extra = {}) => ({ id, page: 1, label, maxLen: 0, comb: false, box: [0, 0, 100, 20], ...extra });
const plan = (fields, self = DETAILS, spouse = null) => plain(app.m.planAutofill({ fields, self, spouse, now: NOW }));
const valueOf = (p, id) => p.find(x => x.id === id)?.value;

test('planAutofill derives full name, city/state/zip and full address', () => {
  const p = plan([F('n', 'Name'), F('c', 'City, state, and ZIP code'), F('a', 'Address, city, state, ZIP')]);
  assert.equal(valueOf(p, 'n'), 'Jane Q. Doe');
  assert.equal(valueOf(p, 'c'), 'Springfield, IL 62704');
  assert.equal(valueOf(p, 'a'), '12 Elm St Apt 4, Springfield, IL 62704');
  assert.equal(valueOf(plan([F('n', 'Name')], { ...DETAILS, middleName: '' }), 'n'), 'Jane Doe');
  assert.equal(valueOf(plan([F('n', 'Name')], { ...DETAILS, lastName: '' }), 'n'), undefined, 'a first name alone is not a full name');
});
test('planAutofill writes today in the chosen date format', () => {
  for (const [dateFormat, want] of [['MM/DD/YYYY', '10/05/2026'], ['DD/MM/YYYY', '05/10/2026'], ['YYYY-MM-DD', '2026-10-05']]) {
    assert.equal(valueOf(plan([F('d', 'Date')], { ...DETAILS, dateFormat }), 'd'), want);
  }
});
test('planAutofill marks SSN and date of birth sensitive and nothing else', () => {
  const p = plan([F('s', 'Social security number'), F('b', 'Date of birth'), F('e', 'Email'), F('n', 'First name')]);
  assert.deepEqual(p.map(x => [x.id, x.sensitive]), [['s', true], ['b', true], ['e', false], ['n', false]]);
});
test('planAutofill skips values that do not fit and never truncates', () => {
  const p = plan([F('e', 'Email', { maxLen: 5 }), F('n', 'First name', { maxLen: 3 }), F('n2', 'First name', { maxLen: 10 })]);
  assert.deepEqual(p.map(x => x.id), ['n2']);
});
test('planAutofill falls back to digits when maxLen is short, else skips', () => {
  const p = plan([F('s', 'SSN', { maxLen: 9 }), F('s2', 'SSN', { maxLen: 5 }), F('p', 'Phone', { maxLen: 10 }), F('z', 'ZIP', { maxLen: 5 }), F('z2', 'ZIP', { maxLen: 5 })], { ...DETAILS, zip: '62704-1234' });
  assert.equal(valueOf(p, 's'), '123456789');
  assert.equal(valueOf(p, 's2'), undefined);
  assert.equal(valueOf(p, 'p'), '5551234567');
  assert.equal(valueOf(p, 'z'), undefined, '9 digits do not fit a 5-digit ZIP');
  assert.equal(valueOf(plan([F('z', 'ZIP', { maxLen: 9 })], { ...DETAILS, zip: '62704-1234' }), 'z'), '627041234');
});
test('planAutofill splits an SSN across a comb run (3/2/4) and a phone across 3/3/4', () => {
  const comb = (id, x, maxLen, extra = {}) => F(id, id === 's1' ? 'Social security number' : 'Other label', { comb: true, maxLen, box: [x, 100, x + maxLen * 12, 120], ...extra });
  const p = plan([comb('s1', 100, 3), comb('s2', 150, 2), comb('s3', 190, 4)]);
  assert.deepEqual(p.map(x => [x.id, x.value, x.sensitive]), [['s1', '123', true], ['s2', '45', true], ['s3', '6789', true]]);
  assert.match(p[2].label, /\(part 3 of 3\)$/);
  const ph = plan([F('p1', 'Phone', { comb: true, maxLen: 3, box: [10, 50, 46, 70] }), F('p2', 'x', { comb: true, maxLen: 3, box: [60, 52, 96, 72] }), F('p3', 'x', { comb: true, maxLen: 4, box: [110, 50, 158, 70] })]);
  assert.deepEqual(ph.map(x => x.value), ['555', '123', '4567']);
  // a different row or page is not part of the run
  const apart = plan([comb('s1', 100, 3), comb('s2', 150, 2, { box: [150, 160, 174, 180] }), comb('s3', 190, 4, { page: 2 })]);
  assert.deepEqual(apart.map(x => x.id), []);
});
test('a custom entry matches by label, overrides the rules and is checked first', () => {
  const details = { ...DETAILS, custom: [{ label: 'Driver license no.', value: 'D123' }, { label: 'First name', value: 'Janey' }, { label: 'Landlord', value: 'John' }] };
  const p = plan([F('d', 'Driver\'s license no. (state issued)'), F('x', 'driver license no'), F('f', 'First name'), F('sp', 'Landlord\'s name')], details);
  assert.equal(valueOf(p, 'd'), 'D123', 'punctuation is ignored when matching words');
  assert.equal(valueOf(p, 'x'), 'D123');
  assert.equal(valueOf(p, 'f'), 'Janey');
  assert.equal(valueOf(p, 'sp'), 'John', 'custom entries can override the other-party skip');
  assert.equal(plan([F('d', 'Please enter your driver license no. here')], details)[0].value, 'D123');
});
test('missing details propose nothing', () => {
  assert.deepEqual(plan([F('n', 'First name'), F('c', 'City'), F('a', 'Address'), F('d', 'Date of birth'), F('s', 'SSN'), F('n2', 'Name')], {}).map(x => x.id), []);
  assert.deepEqual(plan([F('x', 'Favourite colour'), F('y', 'Field 4')]), []);
});

// ---------- storage ----------
const profile = (name, details, id) => ({ ...(id ? { id } : {}), name, details });
const setP = (t, profiles, extra = {}) => t.handlers.get('profiles-set')(null, { profiles, ...extra });
const getP = t => t.handlers.get('profiles-get')().then(plain);
// Saves self (and optionally spouse) profiles and returns their ids
async function seed(t, self = DETAILS, spouse = null) {
  const r = await setP(t, [profile('Me', self), ...(spouse ? [profile('Partner', spouse)] : [])]);
  assert.equal(r.success, true, r.error);
  const g = await getP(t);
  return { selfId: g.profiles[0].id, spouseId: spouse ? g.profiles[1].id : null };
}

test('profiles round trip encrypted when safeStorage is available, with no plaintext in the file', async () => {
  const t = boot();
  const empty = await getP(t);
  assert.equal(empty.success, true);
  assert.deepEqual([empty.profiles, empty.lastSelf, empty.lastSpouse, empty.encrypted], [[], null, null, true]);
  const saved = await setP(t, [profile('Me', { ...DETAILS, custom: [{ label: 'Passport', value: 'X9' }] }), profile('Partner', SPOUSE)]);
  assert.deepEqual([saved.success, saved.encrypted], [true, true]);
  const raw = fs.readFileSync(t.file, 'utf8');
  assert.equal(JSON.parse(raw).v, 2);
  for (const secret of ['Jane', '123-45-6789', 'Springfield', 'Passport', 'Partner', 'Roe', '987-65-4321']) assert.ok(!raw.includes(secret), secret);
  if (process.platform !== 'win32') assert.equal(fs.statSync(t.file).mode & 0o777, 0o600); // Windows has no POSIX file modes
  const back = await getP(t);
  assert.equal(back.encrypted, true);
  assert.deepEqual(back.profiles.map(p => p.name), ['Me', 'Partner']);
  assert.equal(new Set(back.profiles.map(p => p.id)).size, 2);
  assert.match(back.profiles[0].id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(back.profiles[0].details, { ...DETAILS, custom: [{ label: 'Passport', value: 'X9' }] });
  assert.equal(back.profiles[1].details.lastName, 'Roe');
});
test('profiles are stored as plain JSON when encryption is unavailable', async () => {
  const t = boot({ encrypt: false });
  const saved = await setP(t, [profile('Me', DETAILS), profile('Partner', SPOUSE)]);
  assert.deepEqual([saved.success, saved.encrypted], [true, false]);
  assert.equal(JSON.parse(fs.readFileSync(t.file, 'utf8')).plain.profiles[1].details.firstName, 'John');
  const back = await getP(t);
  assert.deepEqual([back.encrypted, back.profiles[0].details.ssn, back.profiles.length], [false, '123-45-6789', 2]);
});
test('profiles-set validates names, count, ids and the remembered choices', async () => {
  const t = boot({ encrypt: false });
  const rejects = async (profiles, what) => { const r = await setP(t, profiles); assert.equal(r.success, false, what); assert.ok(r.error, what); };
  await rejects([profile('A', {}), profile(' a ', {})], 'duplicate names, case-insensitive and trimmed');
  await rejects([profile('', {})], 'empty name');
  await rejects([profile('   ', {})], 'blank name');
  await rejects([{ details: {} }], 'missing name');
  await rejects([profile('x'.repeat(61), {})], 'over-long name');
  await rejects(Array.from({ length: 51 }, (_, i) => profile('P' + i, {})), 'more than 50 profiles');
  await rejects('nope', 'not a list');
  assert.equal(fs.existsSync(t.file), false, 'a rejected save writes nothing');
  assert.equal((await setP(t, Array.from({ length: 50 }, (_, i) => profile('P' + i, {})))).success, true);
  assert.equal((await setP(t, [profile('x'.repeat(60), {})])).success, true);
  const ok = await setP(t, [profile('A', {}, 'id-a'), profile('B', {}, 'id-b')], { lastSelf: 'id-a', lastSpouse: 'id-b' });
  assert.equal(ok.success, true);
  let g = await getP(t);
  assert.deepEqual([g.lastSelf, g.lastSpouse], ['id-a', 'id-b']);
  await setP(t, [profile('A', {}, 'id-a')], { lastSelf: 'id-zzz', lastSpouse: 'id-b' });
  g = await getP(t);
  assert.deepEqual([g.lastSelf, g.lastSpouse], [null, null], 'unknown ids become null');
});
test('profile details keep only known keys, string values up to 500 chars, and non-empty custom entries', async () => {
  const t = boot({ encrypt: false });
  const custom = [{ label: 'ok', value: 'v' }, { label: '', value: 'no label' }, { label: 'no value', value: '' }, { label: 'x'.repeat(101), value: 'v' }, { label: 'long', value: 'y'.repeat(501) }, null, { label: 5, value: 'v' }];
  await setP(t, [profile('Me', { firstName: 'Jane', lastName: 'z'.repeat(501), email: 7, hacker: 'x', ssn: 's'.repeat(500), dateFormat: 'DD.MM.YY', custom })]);
  const d = (await getP(t)).profiles[0].details;
  assert.equal(d.firstName, 'Jane');
  assert.equal(d.lastName, '');
  assert.equal(d.email, '');
  assert.equal(d.ssn.length, 500);
  assert.equal(d.dateFormat, 'MM/DD/YYYY');
  assert.equal('hacker' in d, false);
  assert.deepEqual(d.custom, [{ label: 'ok', value: 'v' }]);
  const many = await setP(t, [profile('Me', { custom: Array.from({ length: 250 }, (_, i) => ({ label: 'l' + i, value: 'v' })) })]);
  assert.equal(many.success, true);
  assert.equal((await getP(t)).profiles[0].details.custom.length, 200);
  assert.equal(JSON.stringify(Object.keys(d).sort()), JSON.stringify([...Object.keys(DETAILS), 'custom'].sort()));
});
test('profiles-remember changes only the remembered choices', async () => {
  const t = boot();
  await setP(t, [profile('A', DETAILS, 'a'), profile('B', SPOUSE, 'b')]);
  const before = (await getP(t)).profiles;
  assert.equal((await t.handlers.get('profiles-remember')(null, { lastSelf: 'b', lastSpouse: 'a' })).success, true);
  const g = await getP(t);
  assert.deepEqual([g.lastSelf, g.lastSpouse, g.profiles], ['b', 'a', before]);
  await t.handlers.get('profiles-remember')(null, { lastSelf: 'gone', lastSpouse: null });
  assert.deepEqual([(await getP(t)).lastSelf, (await getP(t)).lastSpouse], [null, null]);
});
test('a corrupt or undecryptable file gives no profiles and a warning, never an error', async () => {
  const t = boot();
  for (const text of ['{not json', '{"v":2,"enc":"AAAA"}', '{"v":2}', '[]']) {
    fs.writeFileSync(t.file, text);
    const r = await getP(t);
    assert.equal(r.success, true, text);
    assert.deepEqual(r.profiles, []);
    assert.ok(r.warning, text);
  }
  const kept = fs.readdirSync(path.dirname(t.file)).filter(f => /^profiles\.unreadable-\d+\.json$/.test(f));
  assert.ok(kept.length >= 1, 'unreadable file kept');
  assert.ok(!fs.existsSync(t.file), 'unreadable file moved aside, so a save cannot overwrite it');
  const keyringGone = boot({ encrypt: false });
  fs.writeFileSync(keyringGone.file, JSON.stringify({ v: 2, enc: 'AAAA' }));
  assert.ok((await getP(keyringGone)).warning);
});
test('a v1 my-details.json becomes one "Me" profile, the old file is renamed (never deleted) and nothing migrates twice', async () => {
  for (const encrypt of [true, false]) {
    const t = boot({ encrypt });
    const d = { ...DETAILS, custom: [{ label: 'Passport', value: 'X9' }] };
    fs.writeFileSync(t.oldFile, JSON.stringify(encrypt ? { v: 1, enc: Buffer.from('ENC:' + Buffer.from(JSON.stringify(d)).toString('hex')).toString('base64') } : { v: 1, plain: d }));
    const g = await getP(t);
    assert.equal(g.success, true);
    assert.deepEqual(g.profiles.map(p => p.name), ['Me']);
    assert.deepEqual(g.profiles[0].details, d);
    assert.equal(g.encrypted, encrypt);
    assert.ok(fs.existsSync(t.file), 'profiles.json written');
    assert.ok(!fs.existsSync(t.oldFile), 'old file moved');
    const migrated = path.join(path.dirname(t.file), 'my-details.migrated.json');
    assert.ok(fs.existsSync(migrated), 'old file kept as my-details.migrated.json');
    const id = g.profiles[0].id;
    fs.writeFileSync(t.oldFile, JSON.stringify({ v: 1, plain: { firstName: 'Other' } }));
    const again = await getP(t);
    assert.deepEqual(again.profiles.map(p => [p.id, p.details.firstName]), [[id, 'Jane']], 'a second get does not migrate again');
  }
  const none = boot();
  assert.deepEqual((await getP(none)).profiles, []);
  assert.ok(!fs.existsSync(none.file), 'nothing to migrate writes nothing');
  const bad = boot();
  fs.writeFileSync(bad.oldFile, '{not json');
  assert.deepEqual((await getP(bad)).profiles, []);
  assert.ok(fs.existsSync(bad.oldFile), 'an unreadable old file is left alone');
});

// ---------- real forms ----------
const pdfjs = () => import('pdfjs-dist/legacy/build/pdf.mjs');
// Port of pageWords in src/index.html
function pageWords(P, items, vp) {
  const words = [];
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const tx = P.Util.transform(vp.transform, item.transform), h = item.height * vp.scale;
    const charW = (item.width * vp.scale) / item.str.length;
    let x = tx[4];
    for (const part of item.str.split(/(\s+)/)) {
      if (part && part.trim()) words.push({ text: part, box: [x, tx[5] - h, x + part.length * charW, tx[5]] });
      x += part.length * charW;
    }
  }
  return words;
}
// Port of the field collection in fillFromMyDetails
async function collectPages(doc, P) {
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i), vp = page.getViewport({ scale: 150 / 72 });
    const widgets = (await page.getAnnotations()).filter(a => a.subtype === 'Widget' && a.fieldType === 'Tx' && !a.readOnly);
    if (!widgets.length) continue;
    const fields = widgets.map(a => {
      const [ax, ay, bx, by] = vp.convertToViewportRectangle(a.rect);
      return { id: a.id, name: a.fieldName, alt: a.alternativeText, maxLen: a.maxLen || 0, comb: !!a.comb, box: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)] };
    });
    pages.push({ page: i, width: vp.width, fields, words: pageWords(P, (await page.getTextContent()).items, vp) });
  }
  return pages;
}

test('fw9: the plan fills the person\'s own lines only, and splits the SSN over its three comb fields', async () => {
  const P = await pdfjs();
  const doc = await P.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(root, 'tests/fixtures/forms/fw9.pdf'))), standardFontDataUrl: path.join(root, 'node_modules/pdfjs-dist/standard_fonts/'), verbosity: 0 }).promise;
  const pages = (await collectPages(doc, P)).filter(p => p.page === 1);
  const t = boot();
  const { selfId } = await seed(t);
  const r = plain(await t.handlers.get('autofill-plan')(null, { pages, selfId, spouseId: null }));
  assert.equal(r.success, true, r.error);
  // The label of every text field and what it matches, for review
  const planned = new Map(r.plan.map(p => [p.id, p]));
  console.log(pages[0].fields.map(f => {
    const label = app.m.labelFor({ kind: 'text', box: f.box, aboveFirst: f.comb && f.maxLen > 1 }, pages[0].words, pages[0].width / 1275), p = planned.get(f.id);
    return `${f.name.replace(/^topmostSubform\[0\]\.Page1\[0\]\./, '').padEnd(32)} ${JSON.stringify(label).padEnd(64)} -> ${JSON.stringify(app.m.classifyLabel(label)).padEnd(34)} ${p ? JSON.stringify(p.value) + (p.sensitive ? ' (sensitive)' : '') : ''}`;
  }).join('\n'));
  const byName = n => { const f = pages[0].fields.find(f => f.name.endsWith(n)); return planned.get(f.id); };
  assert.equal(byName('f1_01[0]')?.value, 'Jane Q. Doe', 'line 1');
  assert.match(byName('f1_01[0]').label, /^Name of entity\/individual/);
  assert.equal(byName('f1_01[0]').key, 'fullName');
  assert.equal(byName('f1_07[0]')?.value, '12 Elm St Apt 4', 'line 5');
  assert.equal(byName('f1_08[0]')?.value, 'Springfield, IL 62704', 'line 6');
  assert.deepEqual(['f1_11[0]', 'f1_12[0]', 'f1_13[0]'].map(n => [byName(n)?.value, byName(n)?.sensitive]), [['123', true], ['45', true], ['6789', true]]);
  for (const n of ['f1_02[0]', 'f1_03[0]', 'f1_04[0]', 'f1_05[0]', 'f1_06[0]', 'f1_09[0]', 'f1_10[0]', 'f1_14[0]', 'f1_15[0]']) assert.equal(byName(n), undefined, n + ' stays empty');
  assert.equal(r.plan.length, 6);
  assert.ok(r.plan.every(p => p.who === 'self'));
  assert.equal(r.encrypted, true);
});

// The 8822 PDF is not in the repo, so its labels are laid out by hand: each label sits above its field, as on the form.
test('8822-style labels: only the person\'s own fields are planned', async () => {
  const labels = [['Your name (first name, initial, and last name)', 'Jane Q. Doe'], ['Spouse\'s name (first name, initial, and last name)'], ['Your prior name(s)'], ['Your old address (no., street, apt. no., city or town, state, and ZIP code)'], ['Foreign country name'], ['Decedent\'s name'], ['Daytime telephone number of person to contact (optional)', '555-123-4567'], ['Your social security number', '123-45-6789'], ['Spouse\'s social security number']];
  const words = [], fields = [];
  labels.forEach(([text], i) => {
    const y = 100 + i * 100;
    text.split(' ').forEach((w, j) => words.push({ text: w, box: [80 + j * 60, y, 130 + j * 60, y + 20] }));
    fields.push({ id: 'f' + i, name: 'Field ' + (i + 1), alt: '', maxLen: 0, comb: false, box: [75, y + 25, 900, y + 60] });
  });
  const t = boot({ encrypt: false });
  const { selfId, spouseId } = await seed(t, DETAILS, SPOUSE);
  const pages = [{ page: 1, width: 1275, fields, words }];
  const r = plain(await t.handlers.get('autofill-plan')(null, { pages, selfId, spouseId: null }));
  assert.deepEqual(r.plan.map(p => [p.id, p.value]), labels.map(([, v], i) => v && ['f' + i, v]).filter(Boolean));
  assert.equal(r.encrypted, false);
  // with a spouse profile chosen, the spouse lines are filled from it and the self lines are unchanged
  const w = plain(await t.handlers.get('autofill-plan')(null, { pages, selfId, spouseId }));
  assert.deepEqual(w.plan.map(p => [p.id, p.who, p.value]), [['f0', 'self', 'Jane Q. Doe'], ['f1', 'spouse', 'John Roe'], ['f6', 'self', '555-123-4567'], ['f7', 'self', '123-45-6789'], ['f8', 'spouse', '987-65-4321']]);
  assert.deepEqual(w.plan.map(p => p.sensitive), [false, false, false, true, true]);
  assert.equal((await t.handlers.get('autofill-plan')(null, { pages, selfId, spouseId: 'nope' })).success, false);
  assert.equal((await t.handlers.get('autofill-plan')(null, { pages, selfId: 'nope', spouseId: null })).success, false);
});
test('autofill-plan prefers the tooltip, then the printed label, then a human field name', async () => {
  const t = boot();
  const { selfId } = await seed(t);
  const words = [{ text: 'Surname', box: [10, 100, 90, 120] }];
  const fields = [
    { id: 'a', name: 'x', alt: 'First name', maxLen: 0, comb: false, box: [100, 100, 300, 120] },
    { id: 'b', name: 'y', alt: '', maxLen: 0, comb: false, box: [100, 100, 300, 120] },
    { id: 'c', name: 'Email address', alt: '', maxLen: 0, comb: false, box: [100, 400, 300, 420] },
    { id: 'd', name: 'topmostSubform[0].Page1[0].email[0]', alt: '', maxLen: 0, comb: false, box: [100, 500, 300, 520] },
    { id: 'e', name: 'f1_01', alt: '', maxLen: 0, comb: false, box: [100, 600, 300, 620] }
  ];
  const r = plain(await t.handlers.get('autofill-plan')(null, { pages: [{ page: 1, width: 1275, fields, words }], selfId }));
  assert.deepEqual(r.plan.map(p => [p.id, p.value]), [['a', 'Jane'], ['b', 'Doe'], ['c', 'jane@example.com']]);
});

test('another person anywhere in the label blocks the match, even after the head', () => {
  for (const l of ['Name (first and last name of spouse)', 'Phone (of emergency contact)', 'Address. Enter the address of the child', 'Name (as shown on the dependent\'s card)'])
    assert.equal(app.m.classifyLabel(l), null, l);
  for (const l of ['Spouse\'s name (witness)', 'Spouse\'s emergency contact', 'Landlord and spouse phone', 'Husband\'s decedent name'])
    assert.equal(app.m.classifyLabel(l), null, l);
  assert.deepEqual(plain(app.m.classifyLabel('Wife\'s phone number')), { who: 'spouse', key: 'phone' });
  assert.equal(plain(app.m.classifyLabel('Name of entity/individual. An entry is required. (For a sole proprietor or disregarded entity, enter the owner\'s name on line 1, and enter the business/disregarded entity\'s name on line 2.)')).key, 'fullName');
});

test('spouse fields: skipped without a spouse profile, filled from the spouse when one is chosen, never from self', () => {
  const fields = [F('n', 'Your name (first name, initial, and last name)'), F('sn', 'Spouse\'s name (first name, initial, and last name)'), F('ss', 'Spouse\'s social security number'), F('sp', 'Spouse\'s prior name(s)')];
  const without = plan(fields);
  assert.deepEqual(without.map(x => [x.id, x.who]), [['n', 'self']]);
  const withSpouse = plan(fields, DETAILS, SPOUSE);
  assert.deepEqual(withSpouse.map(x => [x.id, x.who, x.key, x.value, x.sensitive]), [['n', 'self', 'fullName', 'Jane Q. Doe', false], ['sn', 'spouse', 'fullName', 'John Roe', false], ['ss', 'spouse', 'ssn', '987-65-4321', true]]);
  // a spouse profile that lacks a value leaves the field empty instead of borrowing the self value
  assert.deepEqual(plan([F('ss', 'Spouse\'s social security number'), F('sd', 'Spouse\'s date of birth')], DETAILS, { firstName: 'John' }), []);
  // a custom entry on the spouse profile applies to spouse fields only
  assert.equal(valueOf(plan([F('c', 'Spouse\'s name')], { ...DETAILS, custom: [{ label: 'Spouse\'s name', value: 'SELF' }] }, { ...SPOUSE, custom: [{ label: 'Spouse\'s name', value: 'SPOUSE' }] }), 'c'), 'SPOUSE');
});
test('self and spouse SSN comb runs on one page are both split correctly', () => {
  const comb = (id, label, x, y, maxLen) => F(id, label, { comb: true, maxLen, box: [x, y, x + maxLen * 12, y + 20] });
  const p = plan([
    comb('a1', 'Your social security number', 100, 100, 3), comb('a2', 'x', 150, 100, 2), comb('a3', 'x', 190, 100, 4),
    comb('b1', 'Spouse\'s social security number', 100, 200, 3), comb('b2', 'x', 150, 200, 2), comb('b3', 'x', 190, 200, 4)
  ], DETAILS, SPOUSE);
  assert.deepEqual(p.map(x => [x.id, x.who, x.value, x.sensitive]), [['a1', 'self', '123', true], ['a2', 'self', '45', true], ['a3', 'self', '6789', true], ['b1', 'spouse', '987', true], ['b2', 'spouse', '65', true], ['b3', 'spouse', '4321', true]]);
  assert.deepEqual(plan([comb('b1', 'Spouse\'s social security number', 100, 200, 3), comb('b2', 'x', 150, 200, 2), comb('b3', 'x', 190, 200, 4)]), []);
});

test('prose questions are not filled with a stored value by the rules', () => {
  const { context } = require('./helpers.cjs').loadMainHandlers();
  for (const l of ['Describe your company', 'Explain your address history', 'Why is your name changing?', 'List your previous employers'])
    assert.equal(context.classifyLabel(l), null, l);
  assert.deepEqual({ ...context.classifyLabel('Company name') }, { who: 'self', key: 'company' });
});
