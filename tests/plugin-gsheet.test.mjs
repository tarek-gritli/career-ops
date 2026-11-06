// tests/plugin-gsheet.test.mjs — the gsheet plugin: header mapping, duplicate
// skipping, and the sheet requests its export hook makes (fake ctx.fetch).
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, ROOT } from './helpers.mjs';
import { colLetter, resolveColumns, isKnownCompany, parseLeads } from '../plugins/gsheet/_sheet.mjs';

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
    if (u.includes('!A:A')) return json({ values: [['F'], ['NVISO (Germany)'], ['Matchory'], [], ['Bayshore']] });
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
