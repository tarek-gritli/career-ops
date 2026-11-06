// @ts-check
// Pure, side-effect-free helpers for the gsheet plugin. Files prefixed with _
// are never discovered as plugins.

import { normalizeCompany, companiesMatchIgnoringCorporateForm } from '../../tracker-utils.mjs';

/** The sheet fields a lead can fill. Header names are mapped in config/plugins.yml. */
export const FIELDS = ['company', 'country', 'stage', 'date', 'position', 'contact', 'email', 'website', 'note'];

const CELL_MAX = 500;

/** 0-based column index -> A1 letters (0 -> A, 26 -> AA). */
export function colLetter(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Unencoded A1 reference, for request bodies: tab name quoted. */
export const a1 = (tab, range) => `'${tab.replace(/'/g, "''")}'!${range}`;

/** A1 sheet reference for a URL path: quoted and URL-encoded. */
export const sheetRef = (tab, range) => encodeURIComponent(a1(tab, range));

/**
 * Map each configured field to its column index by HEADER NAME (case/space
 * insensitive), so the plugin works on any sheet layout.
 * A lead needs somewhere to put its contact: `contact`, `email` or `website`.
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
  if (idx.contact === undefined && idx.email === undefined && idx.website === undefined) {
    throw new Error('gsheet: map at least one of settings.columns.contact, email or website');
  }
  return idx;
}

// ── contact validation ───────────────────────────────────────────────────────

const EMAIL = /[^\s@,()<>]+@[^\s@,()<>]+\.[^\s@,()<>]+/;
const HTTPS = /https:\/\/[^\s,()]+/i;

/** True when the text holds an email address or an https URL. */
export const hasReachable = (text) => EMAIL.test(String(text ?? '')) || HTTPS.test(String(text ?? ''));
export const hasEmail = (text) => EMAIL.test(String(text ?? ''));

// ── company identity ─────────────────────────────────────────────────────────

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

// Hosts that say nothing about WHICH company a contact belongs to: free mail and
// shared job boards / ATS. Never used as a company's domain.
const SHARED_HOSTS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'yahoo.com', 'icloud.com',
  'gmx.de', 'gmx.net', 'web.de', 't-online.de', 'proton.me', 'protonmail.com',
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'wellfound.com', 'ycombinator.com', 'github.com', 'notion.site',
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'smartrecruiters.com', 'myworkdayjobs.com',
  'personio.de', 'join.com', 'bamboohr.com', 'recruitee.com', 'teamtailor.com', 'breezy.hr', 'softgarden.io',
  'rexx-systems.com', 'jobs.ch', 'stepstone.de', 'xing.com', 'google.com', 'forms.gle',
]);
const TWO_PART_TLDS = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.au', 'com.br', 'co.jp', 'co.in', 'com.tr', 'co.nz', 'com.mx', 'co.za']);

/** Registrable domain of a host: "careers.acme.co.uk" -> "acme.co.uk". */
function registrable(host) {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return TWO_PART_TLDS.has(last2) ? parts.slice(-3).join('.') : last2;
}

/**
 * Company domains named in free text (emails and URLs), minus shared hosts.
 * "kaan@invertix.ai (CTO), https://invertix.ai" -> {"invertix.ai"}.
 * @param {...unknown} texts
 * @returns {Set<string>}
 */
export function domainsOf(...texts) {
  const out = new Set();
  const add = (host) => { const d = registrable(host); if (d.includes('.') && !SHARED_HOSTS.has(d)) out.add(d); };
  for (const t of texts) {
    const s = String(t ?? '');
    for (const m of s.matchAll(/[^\s@,()<>]+@([^\s@,()<>]+\.[^\s@,()<>]+)/g)) add(m[1].replace(/[.;:]+$/, ''));
    for (const m of s.matchAll(/https?:\/\/([^\s/,()]+)/gi)) add(m[1].replace(/:\d+$/, ''));
  }
  return out;
}

/**
 * Find the sheet row a lead already lives in.
 * Domain evidence decides when both sides have it: a shared domain is a match,
 * disjoint domains with the same name are a "possible" duplicate (e.g. two
 * unrelated companies called Hera) that is NOT skipped. Without domains on both
 * sides the name decides.
 * @param {Record<string,string>} lead
 * @param {Array<{name:string, domains:Set<string>}>} rows
 * @returns {{row: any, via: 'domain'|'name'} | {possible: any} | null}
 */
export function matchLead(lead, rows) {
  const ld = domainsOf(lead.contact, lead.email, lead.website);
  let possible = null;
  for (const row of rows) {
    if (ld.size && row.domains.size) {
      if ([...ld].some((d) => row.domains.has(d))) return { row, via: 'domain' };
      if (isKnownCompany(lead.company, [row.name])) possible ??= row;
    } else if (isKnownCompany(lead.company, [row.name])) {
      return { row, via: 'name' };
    }
  }
  return possible ? { possible } : null;
}

// ── leads ────────────────────────────────────────────────────────────────────

/** One-line, length-capped cell text. RAW writes mean no formula can run, but keep cells tidy. */
const cell = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, CELL_MAX);

/**
 * Validate the leads file. Every lead needs a company and a way to reach them:
 * an email address or an https URL, in `contact`, `email` or `website`.
 * @param {unknown} json
 * @returns {Array<Record<string,string>>}
 */
export function parseLeads(json) {
  if (!Array.isArray(json)) throw new Error('gsheet: leads file must be a JSON array of lead objects');
  return json.map((raw, n) => {
    const lead = Object.fromEntries(FIELDS.map((f) => [f, cell(raw?.[f])]));
    if (!lead.company) throw new Error(`gsheet: lead #${n + 1} has no company`);
    if (lead.email && !hasEmail(lead.email)) throw new Error(`gsheet: lead "${lead.company}" has an invalid email "${lead.email}"`);
    if (lead.website && !HTTPS.test(lead.website)) throw new Error(`gsheet: lead "${lead.company}" has a website that is not an https URL: "${lead.website}"`);
    lead.contact ||= [lead.email, lead.website].filter(Boolean).join(', ');
    if (!lead.contact) throw new Error(`gsheet: lead "${lead.company}" has no contact (email or application URL)`);
    if (!hasReachable(lead.contact)) throw new Error(`gsheet: lead "${lead.company}" has no reachable contact: "${lead.contact}" holds neither an email address nor an https URL`);
    return lead;
  });
}

/** Lay a lead out as a sheet row using the resolved column indexes; unmapped columns stay empty. */
export function buildRow(lead, idx, width, defaults = {}) {
  const row = new Array(width).fill('');
  for (const [field, i] of Object.entries(idx)) row[i] = lead[field] || defaults[field] || '';
  return row;
}

/**
 * What a lead may add to a row that already exists. Never overwrites: a field is
 * filled only when its cell is empty. The one exception keeps the old text: a
 * single contact cell that holds a link but no email gets the email in front.
 * @param {Record<string,string>} lead
 * @param {Record<string,number>} idx field -> column index
 * @param {string[]} existingRow the sheet row as read
 * @returns {Array<{col:number, field:string, value:string}>}
 */
export function fillsFor(lead, idx, existingRow) {
  const fills = [];
  for (const [field, col] of Object.entries(idx)) {
    if (field === 'company' || field === 'stage' || field === 'date') continue;
    const have = String(existingRow[col] ?? '').trim();
    const want = lead[field];
    if (!want) continue;
    if (!have) { fills.push({ col, field, value: want }); continue; }
    if (field === 'contact' && !hasEmail(have) && hasEmail(want) && idx.email === undefined) {
      fills.push({ col, field, value: `${want}, ${have}` });
    }
  }
  return fills;
}
