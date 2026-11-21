// Abruf konsolidierter Landesverordnungen aus dem Bürgerservice-Portal
// https://www.gesetze-rechtsprechung.sh.juris.de (juris). Das Portal ist eine
// JavaScript-Anwendung mit sitzungsgebundener API; deshalb wird ein Headless-Chromium
// (playwright-core) verwendet. Chromium-Pfad: env CHROME_PATH, sonst Playwright-Standard.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

const BASE = 'https://www.gesetze-rechtsprechung.sh.juris.de';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function findChrome() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    const dirs = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const f = join(cache, d, sub);
        if (existsSync(f)) return f;
      }
    }
  }
  return undefined; // Playwright-Standard
}

function td() {
  const t = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', emDelimiter: '*' });
  t.use(gfm);
  t.remove(['img', 'script', 'style']);
  return t;
}

/** Extrahiert den Normtext (ohne Navigations-/Fassungsblöcke) aus dem HTML eines juris-Dokumentteils. */
export function extractNorm(html) {
  const { document } = parseHTML(`<div id="root">${html}</div>`);
  const root = document.getElementById('root');
  const text = root.querySelector('.docLayoutText');
  if (!text) return { html: '', markdown: '', plain: '', anlagen: [] };
  for (const el of text.querySelectorAll('.docLayoutMinMax, .docLayoutMinMaxText, #permalink, .unsichtbar, a[name="DocInhalt"]')) el.remove();
  for (const el of text.querySelectorAll('[style]')) el.removeAttribute('style');
  for (const el of text.querySelectorAll('a[href^="#"]')) el.replaceWith(document.createTextNode(el.textContent));
  for (const el of text.querySelectorAll('a[href^="/"]')) el.setAttribute('href', BASE + el.getAttribute('href'));
  for (const el of text.querySelectorAll('a[title]')) el.removeAttribute('title');
  const anlagen = [...text.querySelectorAll('a[href$=".pdf"]')].map((a) => a.getAttribute('href'));
  const inner = text.innerHTML.replace(/<!--[\s\S]*?-->/g, '');
  let markdown = td().turndown(inner).replace(/\n{3,}/g, '\n\n').trim();
  markdown = markdown.replace(/^#### (.+?)\s{2,}\n?(.+)$/m, '#### $1 $2');
  const plain = text.textContent.replace(/\s+/g, ' ').trim();
  markdown = markdown.replace(/Link auf Abbildung\. Ihr Browser kann leider keine eingebetteten Frames anzeigen;[^\n]*/g, '(Anlage als PDF – siehe Link)');
  return { html: inner, markdown, plain, anlagen: [...new Set(anlagen)] };
}

function extractStand(html) {
  const m = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').match(/Stand:\s*(letzte berücksichtigte Änderung:[^]*?\))\s/);
  return m ? m[1].trim() : null;
}

function headInfo(head) {
  const { document } = parseHTML(`<div>${head || ''}</div>`);
  const map = {};
  for (const tr of document.querySelectorAll('tr')) {
    const k = tr.querySelector('th')?.textContent.replace(/\u00a0/g, ' ').replace(/[:\s]+$/g, '').trim();
    const v = tr.querySelector('td')?.textContent.replace(/\s+/g, ' ').trim();
    if (k && v) map[k] = v;
  }
  const g = (label) => Object.entries(map).find(([k]) => k.replace(/\s+/g, ' ').includes(label))?.[1] || null;
  return {
    amtlicheAbkuerzung: g('Abkürzung'),
    ausfertigungsdatum: g('Ausfertigungsdatum'),
    gueltigAb: g('Gültig ab'),
    dokumenttyp: g('Dokumenttyp'),
    fundstelle: g('Fundstelle'),
    gliederungsNr: g('Gliederungs'),
  };
}

/**
 * Lädt eine Norm vollständig (alle Gliederungseinheiten).
 * @param {string} permaKey z. B. "GymOAbiPrO_SH" (aus https://…/perma?j=GymOAbiPrO_SH)
 */
export async function fetchJuris(permaKey) {
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch {
    throw new Error('playwright-core ist nicht installiert (npm i -D playwright-core)');
  }
  const browser = await chromium.launch({ executablePath: findChrome() });
  try {
    const ctx = await browser.newContext({ userAgent: BROWSER_UA, locale: 'de-DE' });
    const page = await ctx.newPage();
    let docBody = null, hdrs = null;
    page.on('request', async (r) => {
      if (r.url().endsWith('/recherche3/document') && !docBody) {
        docBody = r.postData();
        const h = await r.allHeaders();
        hdrs = { 'juris-portalid': h['juris-portalid'], 'x-csrf-token': h['x-csrf-token'] };
      }
    });
    try { await page.goto(`${BASE}/perma?j=${encodeURIComponent(permaKey)}`, { waitUntil: 'commit', timeout: 60000 }); } catch {}
    for (let i = 0; i < 40 && !docBody; i++) await page.waitForTimeout(500);
    if (!docBody) {
      // Fallback: Dokumentansicht direkt öffnen (falls permaKey schon eine docId ist)
      try { await page.goto(`${BASE}/bssh/document/${permaKey}`, { waitUntil: 'commit', timeout: 60000 }); } catch {}
      for (let i = 0; i < 40 && !docBody; i++) await page.waitForTimeout(500);
    }
    if (!docBody) throw new Error(`juris: Dokument für ${permaKey} nicht geladen`);
    await page.waitForTimeout(1500);
    const rootDocId = JSON.parse(docBody).docId.replace(/NN\d+$/, '');
    const res = await page.evaluate(async ({ docBody, hdrs, rootDocId }) => {
      const base = JSON.parse(docBody);
      const call = async (path, body) => {
        const r = await fetch('/jportal/wsrest/recherche3/' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...hdrs }, body: JSON.stringify(body) });
        return r.json();
      };
      const common = { clientID: base.clientID, clientVersion: base.clientVersion, r3ID: base.r3ID };
      const toc = await call('toc', { docId: rootDocId, allNodes: true, ...common });
      if (!toc.root) return { error: toc };
      const nodes = [];
      const walk = (n, d) => { nodes.push({ id: n.dokID, title: n.title, depth: d }); (n.children || []).forEach((c) => walk(c, d + 1)); };
      walk(toc.root, 0);
      const parts = [];
      for (const n of nodes) {
        const d = await call('document', { ...base, docId: n.id });
        parts.push({ ...n, text: d.text || '', head: d.head || '', permalink: d.permalink || null });
      }
      return { parts };
    }, { docBody, hdrs, rootDocId });
    if (res.error) throw new Error('juris API: ' + JSON.stringify(res.error).slice(0, 300));
    const [root, ...rest] = res.parts;
    const teile = rest.map((p) => ({ id: p.id, titel: p.title, ebene: p.depth, permalink: p.permalink, ...extractNorm(p.text) }));
    // Anlagen (PDF) innerhalb der Sitzung laden – ohne Sitzung liefert das Portal 404
    const anlagenDateien = [];
    for (const url of [...new Set(teile.flatMap((t) => t.anlagen))]) {
      try {
        const r = await page.request.get(url, { headers: { referer: `${BASE}/bssh/document/${rootDocId}` } });
        const body = await r.body();
        if (r.ok() && body.slice(0, 4).toString() === '%PDF') anlagenDateien.push({ url, buffer: body });
        else anlagenDateien.push({ url, fehler: `HTTP ${r.status()}` });
      } catch (e) { anlagenDateien.push({ url, fehler: e.message }); }
    }
    return {
      anlagenDateien,
      permaKey,
      docId: rootDocId,
      titel: root.title,
      stand: extractStand(root.text),
      kopf: headInfo(root.head),
      permalink: `${BASE}/perma?j=${permaKey}`,
      teile,
    };
  } finally {
    await browser.close();
  }
}
