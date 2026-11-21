import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const p = (...parts) => join(ROOT, ...parts);

export const UA = 'Mozilla/5.0 (compatible; abitur-sh-quellen/1.0; +https://github.com/) quellen-archiv';

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

export function readYaml(file) {
  return yaml.load(readFileSync(file, 'utf8'));
}

export function readJson(file, fallback = undefined) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

const UMLAUT = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'ae', Ö: 'oe', Ü: 'ue', ß: 'ss' };
export function slug(s) {
  return String(s)
    .replace(/[äöüÄÖÜß]/g, (c) => UMLAUT[c])
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Today in Europe/Berlin as YYYY-MM-DD */
export function today() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
}

export function nowIso() {
  return new Date().toISOString();
}

/** YYYY-MM-DD -> DD.MM.YYYY */
export function deDate(iso) {
  if (!iso) return '–';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export function deDateLong(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d}. ${MONATE[m - 1]} ${y}`;
}

/**
 * Normalise text for quote verification: dehyphenate line breaks, unify quotes/dashes,
 * collapse whitespace. Applied identically to source text and quotes.
 */
export function normQuote(s) {
  return String(s)
    .replace(/­/g, '')
    .replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, '$1$2')
    .replace(/[„“”‟″"]/g, '"')
    .replace(/[‚‘’‛′']/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/[•▪■●◦]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchWithRetry(url, opts = {}, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        ...opts,
        headers: { 'user-agent': UA, 'accept-language': 'de-DE,de;q=0.9', ...(opts.headers || {}) },
        signal: AbortSignal.timeout(opts.timeout || 90000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`);
      return res;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}
