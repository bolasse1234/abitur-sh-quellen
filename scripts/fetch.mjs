#!/usr/bin/env node
// Ruft alle offiziellen Quellen aus sources/sources.yaml ab, folgt den Entdeckungsregeln
// (ZIP/PDF/juris), speichert Schnappschüsse in snapshots/ und Originaldateien in public/dateien/.
//
//   npm run fetch                 # alles
//   npm run fetch -- --nur za-termine,oapvo
//   npm run fetch -- --ohne-juris # ohne Headless-Browser (juris bleibt auf altem Stand)
//
// Abrufdatum („abgerufen“) wird bei jedem erfolgreichen Abruf gesetzt, „geaendert“ nur wenn
// sich der Inhalt (SHA-256) geändert hat. Fehlgeschlagene Quellen behalten ihren alten Stand.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, statSync, rmSync, copyFileSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, extname, basename, dirname } from 'node:path';
import { p, readYaml, readJson, writeJson, writeText, sha256, slug, today, nowIso, fetchWithRetry } from './lib/util.mjs';
import { fetchPage, parseTermine, cleanUrl } from './lib/html.mjs';

const args = process.argv.slice(2);
const only = (() => { const i = args.indexOf('--nur'); return i >= 0 ? new Set(args[i + 1].split(',')) : null; })();
const ohneJuris = args.includes('--ohne-juris');

const reg = readYaml(p('sources/sources.yaml'));
const INDEX_FILE = p('snapshots/index.json');
const index = readJson(INDEX_FILE, { quellen: {}, dokumente: {} });
const heute = today();
const log = (...a) => console.log(...a);
const problems = [];
const seen = new Set();
const failed = new Set();

function record(id, meta, contentHash) {
  const prev = index.quellen[id] || {};
  const changed = prev.sha256 !== contentHash;
  index.quellen[id] = {
    ...prev,
    ...meta,
    id,
    sha256: contentHash,
    abgerufen: heute,
    geaendert: changed ? heute : prev.geaendert || heute,
    erstmals: prev.erstmals || heute,
    status: 'ok',
    fehler: null,
    verlinkt: true,
  };
  seen.add(id);
  log(`  ${changed ? (prev.sha256 ? '✱ GEÄNDERT' : '+ neu') : '= unverändert'}  ${id}`);
  return changed;
}

function fail(id, meta, err) {
  const prev = index.quellen[id] || {};
  index.quellen[id] = { ...prev, ...meta, id, status: 'fehler', fehler: String(err.message || err).slice(0, 300), fehlerAm: heute };
  seen.add(id);
  failed.add(id);
  problems.push(`${id}: ${err.message || err}`);
  log(`  ✗ FEHLER ${id}: ${err.message || err}`);
}

function subst(tpl, m) {
  return String(tpl).replace(/\$(\d)/g, (_, n) => m[Number(n)] ?? '');
}

/** Stabile Dokument-ID aus Dateiname (ohne Datums-/Versionsanhängsel). */
function docKey(name) {
  let s = name.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' ');
  s = s
    .replace(/\b\d{8}\b/g, ' ')
    .replace(/\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g, ' ')
    .replace(/\b\d{2} \d{2} \d{2}\b/g, ' ')
    .replace(/\bNEU\b/gi, ' ')
    .replace(/\bAbitur\s+20\d\d\b/gi, ' ')
    .replace(/\b20\d\d\b/g, ' ')
    .replace(/\bAbitur\s*$/i, ' ');
  return slug(s) || slug(name);
}

function pdfText(file, layout = false) {
  try {
    return execFileSync('pdftotext', ['-enc', 'UTF-8', ...(layout ? ['-layout'] : []), file, '-'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8');
  } catch (e) {
    return null;
  }
}

function pdfPages(file) {
  try {
    const out = execFileSync('pdfinfo', [file]).toString();
    return Number(out.match(/Pages:\s+(\d+)/)?.[1]) || null;
  } catch { return null; }
}

function storeFile(srcFile, relPath, meta) {
  // Originaldatei unter public/dateien/<relPath> ablegen, Text extrahieren
  const dest = p('public/dateien', relPath);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(srcFile, dest);
  const buf = readFileSync(dest);
  const hash = sha256(buf);
  const ext = extname(dest).toLowerCase();
  let textFile = null, seiten = null;
  if (ext === '.pdf') {
    const txt = pdfText(dest);
    if (txt) {
      textFile = `snapshots/dokumente/${meta.id}.txt`;
      writeText(p(textFile), txt);
      const lay = pdfText(dest, true);
      if (lay) writeText(p(`snapshots/dokumente/${meta.id}.layout.txt`), lay);
    }
    seiten = pdfPages(dest);
  }
  const prev = index.dokumente[meta.id] || {};
  index.dokumente[meta.id] = {
    ...meta,
    datei: `dateien/${relPath}`,
    groesse: buf.length,
    sha256: hash,
    text: textFile,
    seiten,
    abgerufen: heute,
    geaendert: prev.sha256 === hash ? prev.geaendert || heute : heute,
    erstmals: prev.erstmals || heute,
    verlinkt: true,
  };
  return index.dokumente[meta.id];
}

function sanitizeName(name) {
  const ext = extname(name);
  return slug(basename(name, ext)) + ext.toLowerCase();
}

async function downloadTo(url, file) {
  const res = await fetchWithRetry(url, { timeout: 180000 });
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return { buf, finalUrl: res.url, contentType: res.headers.get('content-type') || '' };
}

/** Download-Zwischenseiten von schleswig-holstein.de enthalten den echten Datei-Link (mm/downloads/…). */
async function resolveDownloadPage(url, extRe) {
  const res = await fetchWithRetry(url);
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('html')) return { direct: true, url: res.url };
  const html = await res.text();
  const re = new RegExp(`href="([^"]+${extRe.source})"`, 'i');
  const m = html.match(re);
  if (!m) throw new Error(`Kein Dateilink auf ${url} gefunden`);
  return { direct: false, url: new URL(m[1].replace(/&amp;/g, '&'), url).href };
}

// ---------------------------------------------------------------------------

async function doSeite(q, parent = null) {
  const pg = await fetchPage(q.url);
  const md = `<!-- Quelle: ${q.url} | abgerufen: ${heute} -->\n${pg.markdown}`;
  writeText(p(`snapshots/seiten/${q.id}.md`), md);
  const changed = record(q.id, {
    titel: q.titel || pg.title, seitentitel: pg.title, url: q.url, typ: 'seite', nutzung: q.nutzung, herausgeber: q.herausgeber,
    letzteAktualisierung: pg.letzteAktualisierung, eltern: parent, hinweis: q.hinweis || null, fach: q.fach || null,
    datei: `snapshots/seiten/${q.id}.md`, abrufweg: pg.via,
  }, sha256(pg.markdown));
  if (q.termine) {
    const termine = parseTermine(pg.html);
    writeJson(p('snapshots/termine.json'), { quelle: q.id, url: q.url, abgerufen: heute, letzteAktualisierung: pg.letzteAktualisierung, jahre: termine });
    log(`    Termine: ${termine.map((t) => `${t.jahr} (${t.zeilen.length})`).join(', ')}`);
  }
  // Entdeckungsregeln
  for (const rule of q.entdecke || []) {
    const re = new RegExp(rule.muster);
    const hits = new Map();
    for (const href of pg.allLinks.map((h) => { try { return new URL(h, q.url).href; } catch { return null; } }).filter(Boolean)) {
      const m = href.match(re);
      if (m && !hits.has(subst(rule.id, m))) hits.set(subst(rule.id, m), { href: cleanUrl(href), m });
    }
    if (!hits.size) { problems.push(`${q.id}: Regel ${rule.muster} fand keinen Link`); log(`    ! Regel ohne Treffer: ${rule.muster}`); }
    for (const [cid, { href, m }] of hits) {
      if (only && !only.has(cid) && !only.has(q.id)) continue;
      const child = {
        id: cid, url: href, typ: rule.typ, nutzung: rule.nutzung, herausgeber: rule.typ === 'juris' ? 'juris' : q.herausgeber,
        titel: subst(rule.titel || cid, m), jahr: rule.jahr ? Number(subst(rule.jahr, m)) : null, kurz: rule.kurz || null,
        permaKey: rule.typ === 'juris' ? m[1] : null, ersatzDocId: rule.ersatzDocId || null,
      };
      try {
        if (child.typ === 'zip') await doZip(child, q.id);
        else if (child.typ === 'pdf') await doPdf(child, q.id);
        else if (child.typ === 'link') await doLink(child, q.id);
        else if (child.typ === 'juris') {
          if (ohneJuris) { log(`    (juris übersprungen: ${cid})`); seen.add(cid); }
          else await doJuris(child, q.id);
        }
      } catch (e) { fail(cid, { ...child, eltern: q.id }, e); }
    }
  }
  return changed;
}

async function doZip(q, parent) {
  const target = await resolveDownloadPage(q.url, /\.zip/);
  const tmp = mkdtempSync(join(tmpdir(), 'abitur-zip-'));
  try {
    const zipFile = join(tmp, 'a.zip');
    const { buf } = await downloadTo(target.url, zipFile);
    const prev = index.quellen[q.id];
    const zipHash = sha256(buf);
    const out = join(tmp, 'x');
    mkdirSync(out);
    execFileSync('unzip', ['-q', '-o', zipFile, '-d', out]);
    const files = [];
    const walk = (d) => { for (const f of readdirSync(d)) { const full = join(d, f); statSync(full).isDirectory() ? walk(full) : files.push(full); } };
    walk(out);
    // alte Dokumente dieses ZIPs als „nicht mehr enthalten“ markieren
    for (const d of Object.values(index.dokumente)) if (d.quelle === q.id) d.verlinkt = false;
    const docIds = [];
    for (const f of files.sort()) {
      const rel = relative(out, f);
      if (basename(f).startsWith('.') || rel.includes('__MACOSX')) continue;
      const parts = rel.split('/');
      const fachOrdner = parts.length > 1 ? parts[parts.length - 2] : 'allgemein';
      const fachSlug = slug(fachOrdner.replace('_', ' '));
      const name = parts[parts.length - 1];
      const id = `${q.jahr}-${fachSlug}-${docKey(name)}`;
      let uniq = id, n = 2;
      while (docIds.includes(uniq)) uniq = `${id}-${n++}`;
      storeFile(f, `pruefungsregelungen/${q.jahr}/${fachSlug}/${sanitizeName(name)}`, {
        id: uniq, quelle: q.id, jahr: q.jahr, fach: fachSlug, fachOrdner, dateiname: name, pfadImZip: rel,
        titel: name.replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' '), nutzung: 'spiegeln',
      });
      docIds.push(uniq);
    }
    record(q.id, { ...q, eltern: parent, zipUrl: target.url, zipName: basename(new URL(target.url).pathname), dokumente: docIds, anzahlDateien: docIds.length }, zipHash);
    if (prev && prev.zipName && prev.zipName !== basename(new URL(target.url).pathname)) log(`    neuer Dateiname: ${basename(new URL(target.url).pathname)}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function doPdf(q, parent) {
  const target = await resolveDownloadPage(q.url, /\.pdf[^"]*/);
  const tmp = mkdtempSync(join(tmpdir(), 'abitur-pdf-'));
  try {
    const f = join(tmp, 'a.pdf');
    const { buf, contentType } = await downloadTo(target.url, f);
    if (!/pdf/i.test(contentType) && buf.slice(0, 4).toString() !== '%PDF') throw new Error(`Keine PDF-Datei (${contentType})`);
    for (const d of Object.values(index.dokumente)) if (d.quelle === q.id) d.verlinkt = false;
    const doc = storeFile(f, `weitere/${q.id}.pdf`, { id: q.id, quelle: q.id, titel: q.titel, dateiname: `${q.id}.pdf`, nutzung: 'spiegeln' });
    record(q.id, { ...q, eltern: parent, dateiUrl: target.url, dokumente: [doc.id] }, sha256(buf));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function doLink(q, parent) {
  // Nur verlinken: Zielseite auflösen, aber die Datei NICHT herunterladen.
  let zipUrl = null;
  try { zipUrl = (await resolveDownloadPage(q.url, /\.zip/)).url; } catch (e) { /* Landingpage reicht */ }
  record(q.id, { ...q, eltern: parent, zipUrl, zipName: zipUrl ? basename(new URL(zipUrl).pathname) : null }, sha256(`${q.url}|${zipUrl}`));
}

async function doJuris(q, parent) {
  const { fetchJuris } = await import('./lib/juris.mjs');
  let r, ersatzHinweis = null;
  try {
    r = await fetchJuris(q.permaKey || q.docId);
  } catch (e) {
    if (!q.ersatzDocId) throw e;
    r = await fetchJuris(q.ersatzDocId);
    ersatzHinweis = `Der Link auf der Landesseite (perma?j=${q.permaKey}) führte beim Abruf im juris-Portal zu keinem Treffer; das Dokument wurde über die Portalsuche ermittelt (Dokument-ID ${q.ersatzDocId}).`;
  }
  if (!r.teile.length) throw new Error('juris: keine Gliederungseinheiten erhalten');
  const { anlagenDateien, ...save } = r;
  writeJson(p(`snapshots/juris/${q.id}.json`), save);
  for (const d of Object.values(index.dokumente)) if (d.quelle === q.id) d.verlinkt = false;
  const docIds = [];
  for (const [i, a] of anlagenDateien.entries()) {
    if (a.fehler) { problems.push(`${q.id}: Anlage ${a.url}: ${a.fehler}`); continue; }
    const tmp = mkdtempSync(join(tmpdir(), 'abitur-anl-'));
    try {
      const f = join(tmp, 'a.pdf');
      writeFileSync(f, a.buffer);
      const teil = r.teile.find((t) => (t.anlagen || []).includes(a.url));
      const id = `${q.id}-${slug(teil?.titel?.split(' - ')[0] || `anlage-${i + 1}`)}`;
      storeFile(f, `recht/${id}.pdf`, { id, quelle: q.id, titel: `${q.kurz || q.id}: ${teil?.titel || 'Anlage'}`, dateiname: basename(new URL(a.url).pathname), originalUrl: a.url, nutzung: 'spiegeln' });
      docIds.push(id);
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  record(q.id, {
    ...q, eltern: parent, docId: r.docId, normStand: r.stand, kopf: r.kopf, anzahlTeile: r.teile.length, dokumente: docIds,
    datei: `snapshots/juris/${q.id}.json`, permalinkDok: `https://www.gesetze-rechtsprechung.sh.juris.de/perma?d=${r.docId}`,
    hinweis: ersatzHinweis || q.hinweis || null,
  }, sha256(r.teile.map((t) => t.plain).join('\n')));
}

// ---------------------------------------------------------------------------

log(`Abruf ${heute} – ${reg.quellen.length} Hauptquellen`);
for (const q of reg.quellen) {
  if (only && !only.has(q.id) && !(q.entdecke || []).length) continue;
  log(`→ ${q.id}`);
  try {
    if (q.typ === 'seite') await doSeite(q);
    else if (q.typ === 'pdf') await doPdf(q, null);
    else if (q.typ === 'zip') await doZip(q, null);
    else if (q.typ === 'juris') { if (ohneJuris) seen.add(q.id); else await doJuris(q, null); }
  } catch (e) { fail(q.id, q, e); }
}

// Quellen, die nicht mehr verlinkt sind, kennzeichnen (nur bei Vollabruf)
if (!only) {
  for (const [id, s] of Object.entries(index.quellen)) {
    // nur markieren, wenn die Elternseite in diesem Lauf erfolgreich abgerufen wurde
    if (!seen.has(id) && s.verlinkt !== false && s.eltern && seen.has(s.eltern) && !failed.has(s.eltern)) { s.verlinkt = false; s.nichtMehrVerlinktSeit = heute; log(`  – nicht mehr verlinkt: ${id}`); }
    else if (!seen.has(id) && s.verlinkt !== false && !s.eltern && !reg.quellen.some((q) => q.id === id)) { s.verlinkt = false; s.nichtMehrVerlinktSeit = heute; log(`  – aus dem Register entfernt: ${id}`); }
  }
}

index.letzterLauf = nowIso();
const aktive = Object.values(index.quellen).filter((s) => s.verlinkt !== false && s.abgerufen);
index.stand = aktive.map((s) => s.abgerufen).sort()[0] || heute; // ältestes Abrufdatum aller aktiven Quellen
index.probleme = problems;
writeJson(INDEX_FILE, index);

log(`\nStand: ${index.stand}  ·  Quellen: ${Object.keys(index.quellen).length}  ·  Dokumente: ${Object.keys(index.dokumente).length}`);
if (problems.length) {
  log(`\n${problems.length} Problem(e):`);
  for (const pr of problems) log('  - ' + pr);
  process.exitCode = 2;
}
// Exit 3 = Abruf weitgehend gescheitert (z. B. Netz/Sperre) – Ergebnis nicht veröffentlichen
const total = Object.values(index.quellen).filter((s) => s.verlinkt !== false).length;
if (failed.size && failed.size >= Math.max(3, total * 0.25)) {
  log(`\n✗ ${failed.size} von ${total} Quellen fehlgeschlagen – Lauf gilt als gescheitert.`);
  process.exitCode = 3;
}
