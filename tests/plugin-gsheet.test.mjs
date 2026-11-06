// tests/plugin-gsheet.test.mjs — the gsheet plugin: header mapping, duplicate
// skipping, and the sheet requests its export hook makes (fake ctx.fetch).
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from './helpers.mjs';
import { colLetter, resolveColumns, isKnownCompany, parseLeads, domainsOf, matchLead, fillsFor } from '../plugins/gsheet/_sheet.mjs';

console.log('\nplugins — gsheet');

const check = (cond, ok, bad) => (cond ? pass(ok) : fail(bad));
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

check(colLetter(0) === 'A' && colLetter(25) === 'Z' && colLetter(26) === 'AA', 'colLetter: A, Z, AA', 'colLetter wrong');

const HEADER = ['F', 'Country', 'Stage', 'Application Date', 'Position', 'URL/Email', 'Note'];
const COLUMNS = { company: 'f', country: 'Country', stage: 'Stage', date: 'Application Date', position: 'Position', contact: 'URL/Email', note: 'Note' };
const idx = resolveColumns(HEADER, COLUMNS);
check(idx.company === 0 && idx.contact === 5 && idx.note === 6, 'resolveColumns maps by header name, case-insensitively', `idx ${JSON.stringify(idx)}`);
check(throws(() => resolveColumns(HEADER, { ...COLUMNS, note: 'Nope' })), 'resolveColumns: unknown header is an error', 'missing header did not throw');
check(throws(() => resolveColumns(HEADER, { company: 'F' })), 'resolveColumns: contact column is required', 'missing contact column did not throw');

const known = ['NVISO (Germany)', 'Matchory', 'Bayshore'];
check(isKnownCompany('NVISO', known), 'qualifier "(Germany)" ignored when matching', 'NVISO not matched');
check(isKnownCompany('Matchory GmbH', known), 'legal form ignored when matching', 'Matchory GmbH not matched');
check(!isKnownCompany('Acme Robotics', known), 'unknown company is new', 'Acme wrongly known');

check(throws(() => parseLeads([{ company: 'X' }])), 'a lead without a contact is rejected', 'no-contact lead accepted');
check(throws(() => parseLeads({})), 'leads file must be an array', 'non-array accepted');

// ── export hook against a fake Sheets API ────────────────────────────────────
const plugin = (await import(pathToFileURL(join(ROOT, 'plugins/gsheet/index.mjs')).href)).default;
const dir = mkdtempSync(join(tmpdir(), 'career-ops-gsheet-'));
try {
  mkdirSync(join(dir, 'data'));
  const leadsPath = join(dir, 'data', 'sheet-leads.json');
  const writeLeads = () => writeFileSync(leadsPath, JSON.stringify([
    { company: 'Matchory', contact: 'dup@matchory.com' },
    { company: 'Acme Robotics', country: 'Munich, Germany', position: 'ai swe', contact: 'jobs@acme.example', note: 'from careers page' },
    { company: 'Acme Robotics GmbH', contact: 'second@acme.example' },
  ]));

  const calls = [];
  const fakeFetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body });
    const u = decodeURIComponent(String(url));
    const json = (o) => ({ json: async () => o });
    if (u.includes('oauth2')) return json({ access_token: 'tok' });
    if (u.includes('!1:1')) return json({ values: [HEADER] });
    if (u.includes('!A:G')) return json({ values: [HEADER, ['NVISO (Germany)'], ['Matchory'], [], ['Bayshore']] });
    return json({});
  };
  const ctx = (dryRun) => ({
    settings: { spreadsheet_id: 'SID', tab: 'Sheet1', columns: COLUMNS },
    env: { GSHEET_CLIENT_ID: 'a', GSHEET_CLIENT_SECRET: 'b', GSHEET_REFRESH_TOKEN: 'c' },
    fetch: fakeFetch, log: () => {}, dryRun, dataRoot: dir,
  });

  writeLeads();
  let r = await plugin.export({}, ctx(true));
  check(r.pushed === 1 && !calls.some((c) => c.method === 'PUT'), 'dry-run: counts the new lead, writes nothing', `dry-run ${JSON.stringify(r)}`);
  check(readFileSync(join(dir, 'data', 'gsheet-companies.txt'), 'utf8') === 'NVISO (Germany)\nMatchory\nBayshore\n', 'dry-run caches the sheet company names', 'company cache wrong');
  check(existsSync(leadsPath), 'dry-run leaves the leads file in place', 'leads file moved by dry-run');

  r = await plugin.export({}, ctx(false));
  const put = calls.find((c) => c.method === 'PUT');
  const body = put && JSON.parse(put.body);
  check(r.pushed === 1 && body?.values?.length === 1, 'real run: duplicates skipped, one row written', `real run ${JSON.stringify(r)}`);
  check(JSON.stringify(body?.values?.[0]) === JSON.stringify(['Acme Robotics', 'Munich, Germany', '', '', 'ai swe', 'jobs@acme.example', 'from careers page']),
    'row follows the sheet header order, stage and date blank', `row ${JSON.stringify(body?.values?.[0])}`);
  check(decodeURIComponent(put?.url || '').includes('!A6:G6') && put?.url.includes('valueInputOption=RAW'),
    'written one row past the last company (row 6), RAW input', `put url ${put?.url}`);
  check(!existsSync(leadsPath) && existsSync(join(dir, 'data', 'sheet-leads.pushed.json')), 'leads file archived after a real run', 'leads file not archived');
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ── contact validation: an email or an https URL, not just any text ──────────
check(throws(() => parseLeads([{ company: 'X', contact: 'see our site' }])), 'contact with no email or https URL is rejected', 'unreachable contact accepted');
check(!throws(() => parseLeads([{ company: 'X', contact: 'jobs@x.example (careers page)' }])), 'email with a trailing source note is accepted', 'annotated email rejected');
check(throws(() => parseLeads([{ company: 'X', email: 'not-an-email' }])), 'an invalid email field is rejected', 'bad email accepted');
check(throws(() => parseLeads([{ company: 'X', website: 'http://x.example' }])), 'a plain-http website is rejected', 'http website accepted');
check(parseLeads([{ company: 'X', email: 'a@x.example', website: 'https://x.example' }])[0].contact === 'a@x.example, https://x.example',
  'email + website compose the contact cell', 'composed contact wrong');

// ── identity: domains decide, names are the fallback ─────────────────────────
const doms = domainsOf('kaan@invertix.ai (CTO), https://www.invertix.ai/jobs', 'x@gmail.com', 'https://acme.greenhouse.io/jobs/1', 'https://careers.foo.co.uk');
check(doms.size === 2 && doms.has('invertix.ai') && doms.has('foo.co.uk'), 'domainsOf: company domains only (no free mail or job boards)', `domains ${[...doms]}`);

const rows = [
  { name: 'Hera', sheetRow: 2, domains: new Set(['hera.video']) },
  { name: 'Acme', sheetRow: 3, domains: new Set(['acme.example']) },
  { name: 'Nodomain Inc', sheetRow: 4, domains: new Set() },
];
check(matchLead({ company: 'Other Name', contact: 'jobs@acme.example' }, rows)?.via === 'domain', 'same domain under another name is a duplicate', 'domain match missed');
const poss = matchLead({ company: 'Hera', contact: 'https://hera.fr' }, rows);
check(poss && 'possible' in poss && !('row' in poss), 'same name, different domain is not skipped (only flagged)', `hera ${JSON.stringify(poss && Object.keys(poss))}`);
check(matchLead({ company: 'Nodomain Inc GmbH', contact: 'https://n.example' }, rows)?.via === 'name', 'no domain on the sheet row: the name decides', 'name fallback missed');
check(matchLead({ company: 'Brand New', contact: 'https://new.example' }, rows) === null, 'unknown company and domain is new', 'false duplicate');

// ── filling existing rows: empty cells only ──────────────────────────────────
const fidx = { company: 0, position: 4, contact: 5, note: 6 };
const fl = { company: 'Acme', position: 'swe', contact: 'a@acme.example (CTO)', note: 'n' };
const fills = fillsFor(fl, fidx, ['Acme', '', '', '', '', 'https://acme.example', '']);
check(fills.length === 3 && fills.find((f) => f.field === 'contact')?.value === 'a@acme.example (CTO), https://acme.example',
  'fillsFor: empty cells filled, a link-only contact gains the email in front', `fills ${JSON.stringify(fills)}`);
check(fillsFor(fl, fidx, ['Acme', '', '', '', 'devops', 'x@acme.example', 'kept']).length === 0,
  'fillsFor: filled cells and a contact that already has an email are never overwritten', 'overwrote existing data');

// ── export hook: write failures, API errors, update mode, separate columns ───
const mkDir = () => { const d = mkdtempSync(join(tmpdir(), 'career-ops-gsheet-')); mkdirSync(join(d, 'data')); return d; };
const mkEnv = { GSHEET_CLIENT_ID: 'a', GSHEET_CLIENT_SECRET: 'b', GSHEET_REFRESH_TOKEN: 'c' };
const reply = (o, ok = true, status = 200) => ({ ok, status, json: async () => o });
/** Fake Sheets API: `sheet` rows, optional failure per request kind. */
const fakeApi = (sheet, { putFails = false, readFails = false, tokenFails = false } = {}) => {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = decodeURIComponent(String(url));
    calls.push({ url: u, method: opts.method || 'GET', body: opts.body });
    if (u.includes('oauth2')) return tokenFails ? reply({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, false, 400) : reply({ access_token: 'tok' });
    if (readFails) return reply({ error: { message: 'Requested entity was not found.' } }, false, 404);
    if (opts.method === 'PUT' && putFails) return reply({ error: { message: 'The caller does not have permission' } }, false, 403);
    if (u.includes('!1:1')) return reply({ values: [sheet[0]] });
    if (u.includes('values:batchUpdate') || opts.method === 'PUT') return reply({});
    return reply({ values: sheet });
  };
  return { fetch, calls };
};
const runExport = async (dir, api, settings, leads, dryRun = false) => {
  writeFileSync(join(dir, 'data', 'sheet-leads.json'), JSON.stringify(leads));
  return plugin.export({}, { settings: { spreadsheet_id: 'SID', tab: 'Sheet1', columns: COLUMNS, ...settings }, env: mkEnv, fetch: api.fetch, log: () => {}, dryRun, dataRoot: dir });
};
const rejects = async (p) => { try { await p; return ''; } catch (e) { return String(e.message); } };

let d2 = mkDir();
try {
  const lead = [{ company: 'Acme Robotics', contact: 'jobs@acme.example' }];
  let msg = await rejects(runExport(d2, fakeApi([HEADER], { putFails: true }), {}, lead));
  check(msg.includes('403') && msg.includes('does not have permission'), 'a failed write throws with Google\'s message and status', `write error: ${msg}`);
  check(existsSync(join(d2, 'data', 'sheet-leads.json')) && !existsSync(join(d2, 'data', 'sheet-leads.pushed.json')),
    'a failed write leaves the leads file for a retry', 'leads file archived after a failed write');

  msg = await rejects(runExport(d2, fakeApi([HEADER], { readFails: true }), {}, lead));
  check(msg.includes('Requested entity was not found') && !msg.includes('no header'), 'a failed read reports the API error, not "no header"', `read error: ${msg}`);

  msg = await rejects(runExport(d2, fakeApi([HEADER], { tokenFails: true }), {}, lead));
  check(msg.includes('Token has been expired or revoked'), 'a failed token refresh reports why', `token error: ${msg}`);

  // update mode
  const sheet = [HEADER, ['Acme', 'Munich', '', '', '', 'https://acme.example', ''], ['Hera', 'Berlin', '', '', '', 'https://hera.video', '']];
  const leads = [
    { company: 'Acme', position: 'swe', contact: 'jobs@acme.example (CTO)', note: 'hello' },
    { company: 'Hera', contact: 'https://hera.fr' },
  ];
  let api = fakeApi(sheet);
  let r = await runExport(d2, api, {}, leads);
  check(r.pushed === 1 && r.updated === 0 && !api.calls.some((c) => c.url.includes('batchUpdate')),
    'default: an already-listed company is skipped, same-named other company added', `default ${JSON.stringify(r)}`);

  api = fakeApi(sheet);
  r = await runExport(d2, api, { update_existing: true }, leads);
  const bu = api.calls.find((c) => c.url.includes('values:batchUpdate'));
  const data = bu && JSON.parse(bu.body).data;
  check(r.updated === 3 && data?.some((x) => x.range === "'Sheet1'!F2" && x.values[0][0] === 'jobs@acme.example (CTO), https://acme.example')
    && data?.some((x) => x.range === "'Sheet1'!E2") && data?.some((x) => x.range === "'Sheet1'!G2"),
  'update_existing: fills empty cells of a listed company in place', `update ${JSON.stringify(r)} ${bu?.body}`);
  check(JSON.parse(bu.body).valueInputOption === 'RAW' && api.calls.find((c) => c.method === 'PUT' && c.url.includes('!A4:G4')),
    'update_existing: new rows still go one past the last row, RAW', 'update/append request wrong');

  // separate email / website columns
  const H2 = ['Company', 'Email', 'Website'];
  api = fakeApi([H2]);
  await runExport(d2, api, { columns: { company: 'Company', email: 'Email', website: 'Website' } },
    [{ company: 'Zed', email: 'a@zed.example', website: 'https://zed.example' }]);
  const put = api.calls.find((c) => c.method === 'PUT');
  check(JSON.stringify(JSON.parse(put.body).values[0]) === JSON.stringify(['Zed', 'a@zed.example', 'https://zed.example']),
    'separate email and website columns are filled when mapped', `separate cols ${put?.body}`);
} finally {
  rmSync(d2, { recursive: true, force: true });
}
