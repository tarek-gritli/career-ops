// @ts-check
// Pure, side-effect-free helpers for the gsheet plugin. Files prefixed with _
// are never discovered as plugins.

import { normalizeCompany, companiesMatchIgnoringCorporateForm } from '../../tracker-utils.mjs';

/** The sheet fields a lead can fill. Header names are mapped in config/plugins.yml. */
export const FIELDS = ['company', 'country', 'stage', 'date', 'position', 'contact', 'note'];

const CELL_MAX = 500;

/** 0-based column index -> A1 letters (0 -> A, 26 -> AA). */
export function colLetter(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** A1 sheet reference: tab name quoted and URL-encoded. */
export const sheetRef = (tab, range) => encodeURIComponent(`'${tab.replace(/'/g, "''")}'!${range}`);

/**
 * Map each configured field to its column index by HEADER NAME (case/space
 * insensitive), so the plugin works on any sheet layout.
 * @param {string[]} headerRow
 * @param {Record<string,string>} columns field -> header text
 * @returns {Record<string, number>} field -> 0-based index (only mapped fields)
 */
export function resolveColumns(headerRow, columns) {
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const idx = {};
  for (const [field, header] of Object.entries(columns || {})) {
    if (!FIELDS.includes(field)) throw new Error(`gsheet: unknown column field "${field}" (allowed: ${FIELDS.join(', ')})`);
    const i = headerRow.findIndex((h) => norm(h) === norm(header));
    if (i < 0) throw new Error(`gsheet: no header "${header}" (for ${field}) in row 1 of the sheet. Headers found: ${headerRow.join(' | ')}`);
    idx[field] = i;
  }
  if (idx.company === undefined) throw new Error('gsheet: settings.columns.company is required');
  if (idx.contact === undefined) throw new Error('gsheet: settings.columns.contact is required');
  return idx;
}

/** Company identity: drop "(Germany)"-style qualifiers, then the tracker's key. */
export const companyKey = (name) => normalizeCompany(String(name ?? '').replace(/\([^)]*\)/g, ' '));

/** True when `name` is already among `existing` (same key, or same name under a different legal form). */
export function isKnownCompany(name, existing) {
  const key = companyKey(name);
  if (!key) return false;
  return existing.some((e) => {
    const k = companyKey(e);
    return k === key || companiesMatchIgnoringCorporateForm(String(name), String(e));
  });
}

/** One-line, length-capped cell text. RAW writes mean no formula can run, but keep cells tidy. */
const cell = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, CELL_MAX);

/**
 * Validate the leads file. Every lead needs a company and a contact (an email
 * or an https application URL), so nothing is written without a way to reach them.
 * @param {unknown} json
 * @returns {Array<Record<string,string>>}
 */
export function parseLeads(json) {
  if (!Array.isArray(json)) throw new Error('gsheet: leads file must be a JSON array of lead objects');
  return json.map((raw, n) => {
    const lead = Object.fromEntries(FIELDS.map((f) => [f, cell(raw?.[f])]));
    if (!lead.company) throw new Error(`gsheet: lead #${n + 1} has no company`);
    if (!lead.contact) throw new Error(`gsheet: lead "${lead.company}" has no contact (email or application URL)`);
    return lead;
  });
}

/** Lay a lead out as a sheet row using the resolved column indexes; unmapped columns stay empty. */
export function buildRow(lead, idx, width, defaults = {}) {
  const row = new Array(width).fill('');
  for (const [field, i] of Object.entries(idx)) row[i] = lead[field] || defaults[field] || '';
  return row;
}
