// Abruf und Umwandlung von HTML-Seiten (schleswig-holstein.de, fachportal.lernnetz.de)
// in sauberes Markdown. Primär direkter HTTP-Abruf; optional Firecrawl (FIRECRAWL_URL).
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { fetchWithRetry } from './util.mjs';

const MAIN_SELECTORS = ['#content', 'main#main', 'main', 'article', 'body'];
const DROP_SELECTORS = [
  'script', 'style', 'noscript', 'nav', 'header', 'footer', 'form', 'iframe', 'svg', 'button',
  '.cookie', '#cookie', '[class*="cookie"]', '[class*="share"]', '.social', '.breadcrumb',
  '.skiplinks', '.navMain', '.service', '[aria-hidden="true"]', '.mod_navigation', '.hidden', '.invisible',
];

function absolutize(doc, base) {
  const baseEl = doc.querySelector('base[href]');
  if (baseEl) { try { base = new URL(baseEl.getAttribute('href'), base).href; } catch {} }
  for (const a of doc.querySelectorAll('a[href]')) {
    try { a.setAttribute('href', new URL(a.getAttribute('href'), base).href); } catch {}
  }
  for (const img of doc.querySelectorAll('img[src]')) {
    try { img.setAttribute('src', new URL(img.getAttribute('src'), base).href); } catch {}
  }
}

function makeTurndown() {
  const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
  td.use(gfm);
  td.remove(['img', 'picture', 'figure']);
  return td;
}

/** Entfernt sitzungsabhängige Query-Parameter, damit Hashes stabil bleiben. */
export function cleanUrl(u) {
  // nur den sitzungs-/navigationsabhängigen Parameter "nn" entfernen, sonst URL unverändert lassen
  return String(u).replace(/([?&])nn=[^&#]*(&?)/, (m, a, b) => (b ? a : '')).replace(/[?&]$/, '').replace(/#.*$/, '');
}

export function htmlToPage(html, url) {
  const { document } = parseHTML(html);
  absolutize(document, url);
  let main = null;
  for (const sel of MAIN_SELECTORS) { main = document.querySelector(sel); if (main) break; }
  for (const sel of DROP_SELECTORS) for (const el of main.querySelectorAll(sel)) el.remove();
  // Tabellenzellen einzeilig machen (Markdown-Tabellen vertragen keine Absätze)
  for (const cell of main.querySelectorAll('td, th')) {
    cell.innerHTML = cell.innerHTML.replace(/<br\s*\/?>/gi, ' ').replace(/<\/?p[^>]*>/gi, ' ');
  }
  for (const el of main.querySelectorAll('img, picture, figure')) el.remove();
  for (const a of main.querySelectorAll('a[title]')) a.removeAttribute('title');
  for (const br of main.querySelectorAll('br')) br.replaceWith(document.createTextNode(' '));
  const h1s = [...main.querySelectorAll('h1')].map((h) => h.textContent.trim().replace(/\s+/g, ' ')).filter((t) => t && !/^Thema\s*:/.test(t));
  const title = h1s[0] || (document.querySelector('title')?.textContent || '').trim().replace(/\s+/g, ' ');
  // Fachportal: Akkordeon-Überschriften als h2 behandeln
  const links = [...main.querySelectorAll('a[href]')].map((a) => ({
    href: a.getAttribute('href'),
    text: a.textContent.trim().replace(/\s+/g, ' '),
  }));
  const allLinks = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));
  let markdown = makeTurndown().turndown(main.innerHTML);
  markdown = markdown
    .replace(/\(\s*(https?:\/\/[^)\s]+)\s*\)/g, (m, u) => `(${cleanUrl(u)})`)
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^# Hinweis zur Verwendung von Cookies[\s\S]*$/m, '')
    .trim() + '\n';
  const lu = markdown.match(/Letzte Aktualisierung:\s*(\d{2})\.(\d{2})\.(\d{4})/);
  const letzteAktualisierung = lu ? `${lu[3]}-${lu[2]}-${lu[1]}` : null;
  return { title, markdown, links, allLinks, letzteAktualisierung };
}

async function viaFirecrawl(url) {
  const base = process.env.FIRECRAWL_URL;
  const res = await fetchWithRetry(`${base.replace(/\/$/, '')}/v2/scrape`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, formats: ['rawHtml'] }),
    timeout: 180000,
  }, 2);
  const j = await res.json();
  if (!j.success) throw new Error(`Firecrawl: ${j.error || 'Fehler'}`);
  return j.data.rawHtml || j.data.html;
}

export async function fetchPage(url) {
  let html, via = 'http';
  try {
    const res = await fetchWithRetry(url);
    html = await res.text();
  } catch (e) {
    if (!process.env.FIRECRAWL_URL) throw e;
    html = await viaFirecrawl(url);
    via = 'firecrawl';
  }
  if (process.env.FIRECRAWL_URL && process.env.FIRECRAWL_PREFER === '1') {
    try { html = await viaFirecrawl(url); via = 'firecrawl'; } catch {}
  }
  return { ...htmlToPage(html, url), html, via };
}

/** Liest Tabellen „Prüfungstermine JJJJ“ aus dem HTML der Terminseite. */
export function parseTermine(html) {
  const { document } = parseHTML(html.replace(/<br\s*\/?>/gi, ' '));
  const out = [];
  for (const h of document.querySelectorAll('h2, h3')) {
    const m = h.textContent.match(/Prüfungstermine\s+(\d{4})/);
    if (!m) continue;
    const jahr = Number(m[1]);
    let el = h.nextElementSibling, table = null, stand = null;
    while (el && !/^H[23]$/.test(el.tagName)) {
      if (!table) table = el.tagName === 'TABLE' ? el : el.querySelector?.('table');
      const sm = el.textContent.match(/Stand:\s*([^\n]+?)(?:,\s*(vorbehaltlich[^\n]*))?$/m);
      if (sm && !stand) stand = { text: el.textContent.trim().replace(/\s+/g, ' ') };
      el = el.nextElementSibling;
    }
    if (!table) continue;
    const rows = [...table.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td,th')].map((c) => c.textContent.trim().replace(/\s+/g, ' ')));
    const [head, ...body] = rows;
    out.push({ jahr, spalten: head, zeilen: body.filter((r) => r.length >= 2).map(([termin, pruefung]) => ({ termin, pruefung })), stand: stand?.text || null });
  }
  return out;
}
