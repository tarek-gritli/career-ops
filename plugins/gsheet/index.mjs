// @ts-check
// Google Sheets plugin — append reviewed company leads to the user's own sheet.
//
// The agent (see skill.md) researches companies and writes them to
// data/sheet-leads.json; this plugin is the deterministic half: it reads the
// sheet, skips companies already listed, and writes the rest under the
// configured headers. Nothing is sent to anyone; the user previews with
// --dry-run and decides.
//
// Enable in config/plugins.yml:
//   gsheet:
//     enabled: true
//     spreadsheet_id: "<id from the sheet URL>"
//     tab: "Sheet1"
//     columns: { company: "Company", contact: "Email / URL", country: "Country", position: "Position", note: "Note", stage: "Stage", date: "Date" }
//     defaults: { stage: "Pending" }
// Add to .env: GSHEET_CLIENT_ID, GSHEET_CLIENT_SECRET, GSHEET_REFRESH_TOKEN.
// Run:  node plugins.mjs run gsheet --dry-run   then   node plugins.mjs run gsheet

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { colLetter, sheetRef, resolveColumns, isKnownCompany, parseLeads, buildRow } from './_sheet.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

async function getAccessToken(env, fetchFn) {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GSHEET_CLIENT_ID,
      client_secret: env.GSHEET_CLIENT_SECRET,
      refresh_token: env.GSHEET_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('gsheet: token refresh returned no access_token');
  return data.access_token;
}

export default {
  /**
   * export: write data/sheet-leads.json to the sheet. The tracker snapshot is
   * unused — this hook mirrors leads, not applications.
   * @param {any} _snapshot
   * @param {any} ctx
   */
  async export(_snapshot, ctx) {
    const s = ctx.settings || {};
    if (!s.spreadsheet_id) throw new Error('gsheet: set plugins.gsheet.spreadsheet_id in config/plugins.yml');
    const tab = s.tab || 'Sheet1';
    const dataPath = (f) => join(ctx.dataRoot, f);
    const leadsPath = dataPath(s.leads_file || 'data/sheet-leads.json');

    const token = await getAccessToken(ctx.env, ctx.fetch);
    const auth = { Authorization: `Bearer ${token}` };
    const get = async (range) => (await (await ctx.fetch(`${API}/${s.spreadsheet_id}/values/${sheetRef(tab, range)}`, { headers: auth })).json()).values || [];

    const header = (await get('1:1'))[0] || [];
    const idx = resolveColumns(header, s.columns);
    const names = (await get(`${colLetter(idx.company)}:${colLetter(idx.company)}`)).map((r) => r[0] ?? '');

    // Local copy of the sheet's company names, so the agent can avoid researching
    // companies the sheet already has without paging the whole sheet itself.
    const cachePath = dataPath('data/gsheet-companies.txt');
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, names.slice(1).filter(Boolean).join('\n') + '\n', 'utf8');
    ctx.log(`gsheet: ${names.length - 1} companies in the sheet (cached to data/gsheet-companies.txt)`);

    if (!existsSync(leadsPath)) { ctx.log(`gsheet: no ${leadsPath} — nothing to add.`); return { pushed: 0 }; }
    const leads = parseLeads(JSON.parse(readFileSync(leadsPath, 'utf8')));

    const known = [...names];
    const fresh = [];
    for (const lead of leads) {
      if (isKnownCompany(lead.company, known)) { ctx.log(`gsheet: skip (already listed): ${lead.company}`); continue; }
      known.push(lead.company);
      fresh.push(lead);
    }

    const width = Math.max(...Object.values(idx), header.length - 1) + 1;
    const rows = fresh.map((l) => buildRow(l, idx, width, s.defaults));
    for (const r of rows) ctx.log(`gsheet: ${ctx.dryRun ? 'would add' : 'adding'}: ${r.filter(Boolean).join(' | ')}`);
    if (ctx.dryRun || rows.length === 0) return { pushed: rows.length };

    // Write at an explicit row (one past the last company) instead of using the
    // append API's table detection, which can land mid-sheet if a blank row exists.
    // ponytail: no grid auto-expand; a sheet with no free rows left fails loudly.
    const first = names.length + 1;
    const range = `${colLetter(0)}${first}:${colLetter(width - 1)}${first + rows.length - 1}`;
    await ctx.fetch(`${API}/${s.spreadsheet_id}/values/${sheetRef(tab, range)}?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ range: decodeURIComponent(sheetRef(tab, range)), majorDimension: 'ROWS', values: rows }),
    });
    renameSync(leadsPath, leadsPath.replace(/\.json$/, '') + '.pushed.json');
    return { pushed: rows.length };
  },
};
