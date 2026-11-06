// @ts-check
// Google Sheets plugin — add reviewed company leads to the user's own sheet.
//
// The agent (see skill.md) researches companies and writes them to
// data/sheet-leads.json; this plugin is the deterministic half: it reads the
// sheet, skips companies already listed (by name, and by website/email domain),
// and writes the rest under the configured headers. With update_existing it also
// fills EMPTY cells of companies that are already listed. Nothing is sent to
// anyone; the user previews with --dry-run and decides.
//
// Enable in config/plugins.yml:
//   gsheet:
//     enabled: true
//     spreadsheet_id: "<id from the sheet URL>"
//     tab: "Sheet1"
//     update_existing: false    # true: fill empty cells of companies already listed
//     columns: { company: "Company", contact: "Email / URL", country: "Country", position: "Position", note: "Note", stage: "Stage", date: "Date" }
//     # optional separate columns: email: "Email", website: "Website"
// Add to .env: GSHEET_CLIENT_ID, GSHEET_CLIENT_SECRET, GSHEET_REFRESH_TOKEN.
// Run:  node plugins.mjs run gsheet --dry-run   then   node plugins.mjs run gsheet

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { colLetter, a1, sheetRef, resolveColumns, parseLeads, buildRow, matchLead, domainsOf, fillsFor } from './_sheet.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';

/** One API call; any HTTP or API-level error is thrown with Google's own message. */
async function call(ctx, url, opts, what) {
  const res = await ctx.fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  if (res.ok === false || data.error) {
    const e = data.error;
    const why = data.error_description || (typeof e === 'string' ? e : e?.message) || 'no details';
    throw new Error(`gsheet: ${what} failed${res.status ? ` (HTTP ${res.status})` : ''}: ${why}`);
  }
  return data;
}

async function getAccessToken(env, ctx) {
  const data = await call(ctx, TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GSHEET_CLIENT_ID,
      client_secret: env.GSHEET_CLIENT_SECRET,
      refresh_token: env.GSHEET_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  }, 'token refresh');
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

    const token = await getAccessToken(ctx.env, ctx);
    const auth = { Authorization: `Bearer ${token}` };
    const get = async (range) => (await call(ctx, `${API}/${s.spreadsheet_id}/values/${sheetRef(tab, range)}`, { headers: auth }, `reading ${range}`)).values || [];

    const header = (await get('1:1'))[0] || [];
    const idx = resolveColumns(header, s.columns);
    const width = Math.max(...Object.values(idx), header.length - 1) + 1;
    const sheet = await get(`${colLetter(0)}:${colLetter(width - 1)}`); // row 0 is the header

    // Local copy of the sheet's company names, so the agent can avoid researching
    // companies the sheet already has without paging the whole sheet itself.
    const cachePath = dataPath('data/gsheet-companies.txt');
    mkdirSync(dirname(cachePath), { recursive: true });
    const names = sheet.map((r) => r[idx.company] ?? '');
    writeFileSync(cachePath, names.slice(1).filter(Boolean).join('\n') + '\n', 'utf8');
    ctx.log(`gsheet: ${names.slice(1).filter(Boolean).length} companies in the sheet (cached to data/gsheet-companies.txt)`);

    if (!existsSync(leadsPath)) { ctx.log(`gsheet: no ${leadsPath} — nothing to add.`); return { pushed: 0, updated: 0 }; }
    const leads = parseLeads(JSON.parse(readFileSync(leadsPath, 'utf8')));

    // What each existing row is: its name, its company domains, and where it sits (1-based).
    const contactCols = ['contact', 'email', 'website'].filter((f) => idx[f] !== undefined).map((f) => idx[f]);
    const known = sheet.slice(1).map((r, i) => ({
      name: r[idx.company] ?? '', sheetRow: i + 2, cells: r,
      domains: domainsOf(...contactCols.map((c) => r[c])),
    })).filter((r) => r.name);

    const fresh = [];
    const updates = [];
    for (const lead of leads) {
      const hit = matchLead(lead, known);
      if (hit && 'row' in hit) {
        // sheetRow 0 = added earlier in this same batch: a duplicate lead, never an update target.
        const fills = s.update_existing && hit.row.sheetRow ? fillsFor(lead, idx, hit.row.cells) : [];
        if (fills.length === 0) { ctx.log(`gsheet: skip (already listed${hit.row.sheetRow ? `, row ${hit.row.sheetRow}` : ' earlier in this file'}, by ${hit.via}): ${lead.company}`); continue; }
        for (const f of fills) updates.push({ sheetRow: hit.row.sheetRow, ...f, company: lead.company });
        ctx.log(`gsheet: ${ctx.dryRun ? 'would fill' : 'filling'} row ${hit.row.sheetRow} (${lead.company}): ${fills.map((f) => f.field).join(', ')}`);
        continue;
      }
      if (hit && 'possible' in hit) ctx.log(`gsheet: note: "${lead.company}" shares a name with row ${hit.possible.sheetRow} but has a different website/email domain — adding it as new`);
      known.push({ name: lead.company, sheetRow: 0, cells: [], domains: domainsOf(lead.contact, lead.email, lead.website) });
      fresh.push(lead);
    }

    const rows = fresh.map((l) => buildRow(l, idx, width, s.defaults));
    for (const r of rows) ctx.log(`gsheet: ${ctx.dryRun ? 'would add' : 'adding'}: ${r.filter(Boolean).join(' | ')}`);
    if (ctx.dryRun || (rows.length === 0 && updates.length === 0)) return { pushed: rows.length, updated: updates.length };

    // Write at an explicit row (one past the last used row) instead of using the
    // append API's table detection, which can land mid-sheet if a blank row exists.
    // ponytail: no grid auto-expand; a sheet with no free rows left fails loudly.
    if (updates.length) {
      await call(ctx, `${API}/${s.spreadsheet_id}/values:batchUpdate`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: updates.map((u) => ({ range: a1(tab, `${colLetter(u.col)}${u.sheetRow}`), values: [[u.value]] })),
        }),
      }, 'updating existing rows');
    }
    if (rows.length) {
      const first = sheet.length + 1;
      const range = `${colLetter(0)}${first}:${colLetter(width - 1)}${first + rows.length - 1}`;
      await call(ctx, `${API}/${s.spreadsheet_id}/values/${sheetRef(tab, range)}?valueInputOption=RAW`, {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: a1(tab, range), majorDimension: 'ROWS', values: rows }),
      }, `writing ${rows.length} new rows`);
    }
    // Only after every write succeeded: a failed run leaves the leads file for a retry.
    renameSync(leadsPath, leadsPath.replace(/\.json$/, '') + '.pushed.json');
    return { pushed: rows.length, updated: updates.length };
  },
};
