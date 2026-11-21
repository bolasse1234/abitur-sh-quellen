// Prüft wörtliche Zitate gegen die gespeicherten Schnappschüsse der Originaldokumente.
import { existsSync, readFileSync } from 'node:fs';
import { p, readJson, readYaml } from './util.mjs';

function norm(s, { dehyph = true, joinHyphen = false } = {}) {
  let t = String(s).replace(/­/g, '');
  if (dehyph) t = t.replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, '$1$2');
  if (joinHyphen) t = t.replace(/-[ \t]*\n\s*/g, '-');
  return t
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/[ﬅﬆ]/g, 'st')
    .replace(/[-]/g, ' ')
    .replace(/[„“”‟″"]/g, '"')
    .replace(/[‚‘’‛′'`´]/g, "'")
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/[•▪■●◦]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Markdown-Syntax entfernen, damit Seitentexte wie Fließtext geprüft werden können. */
function stripMd(md) {
  return md
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\|/g, ' ');
}

const cache = new Map();

/** Tolerante Form für PDFs, deren Ligaturen (tt, ti, ft, fi, fl, ff) bei der Textextraktion verloren gehen. */
function tolerant(s) {
  return norm(s)
    .replace(/(?<=\p{L})[0-9](?=\s?\p{L})/gu, '') // Ersatzzeichen für verlorene Ligaturen (z. B. „hilfsmi4elfrei“, „Prüfungslehrkra1 aus“)
    .replace(/\s+/g, '')
    .replace(/ffi|ffl|ff|fi|fl|ft|tt|ti|tf/g, '')
    .replace(/-/g, '');
}

function zitate(z) {
  return Array.isArray(z) ? z : [z];
}

function variants(raw) {
  const a = norm(raw);
  // aggressive Variante: Trennstriche vor Kleinbuchstaben ganz entfernen (pdftotext entfernt sie teils selbst)
  const agg = a.replace(/-\s?(?=\p{Ll})/gu, '');
  return [a, norm(raw, { dehyph: false }), norm(raw, { dehyph: false, joinHyphen: true }), agg];
}

/** Liefert Textvarianten eines Dokuments, je Seite (Seitenumbruch \f). */
export function docText(docId) {
  if (cache.has(docId)) return cache.get(docId);
  const files = [`snapshots/dokumente/${docId}.txt`, `snapshots/dokumente/${docId}.layout.txt`].map((f) => p(f)).filter(existsSync);
  if (!files.length) { cache.set(docId, null); return null; }
  const sets = files.map((f) => {
    const raw = readFileSync(f, 'utf8');
    const pages = raw.split('\f');
    return { pages: pages.map((pg) => variants(pg)), full: variants(raw), rawPages: pages, raw };
  });
  cache.set(docId, sets);
  return sets;
}

export function findInDoc(docId, zitat) {
  const sets = docText(docId);
  if (!sets) return { status: 'dokument-fehlt' };
  for (const z of zitate(zitat)) {
    const qs = [...new Set(variants(z))];
    for (const set of sets) {
      for (const q of qs) {
        for (let i = 0; i < set.pages.length; i++) {
          if (set.pages[i].some((v) => v.includes(q))) return { status: 'ok', seite: i + 1, zitat: z };
        }
        if (set.full.some((v) => v.includes(q))) {
          const head = q.slice(0, 40);
          const i = set.pages.findIndex((pg) => pg.some((v) => v.includes(head)));
          return { status: 'ok', seite: i >= 0 ? i + 1 : null, seitenuebergreifend: true, zitat: z };
        }
      }
    }
  }
  // Toleranter Abgleich (nur für Dokumente mit fehlerhafter Ligatur-Extraktion)
  for (const z of zitate(zitat)) {
    const tq = tolerant(z);
    for (const set of sets) {
      if (!/[ﬀ-ﬆ]|\p{L}[0-9]\p{L}/u.test(set.raw)) continue;
      for (let i = 0; i < set.pages.length; i++) {
        if (tolerant(set.rawPages[i]).includes(tq)) return { status: 'ok', seite: i + 1, tolerant: true, zitat: z };
      }
    }
  }
  return { status: 'nicht-gefunden' };
}

export function findInText(text, zitat) {
  const hay = variants(text);
  for (const z of zitate(zitat)) {
    const qs = [...new Set(variants(z))];
    if (qs.some((q) => hay.some((h) => h.includes(q)))) return { status: 'ok', zitat: z };
  }
  return { status: 'nicht-gefunden' };
}

export function findInSeite(quelleId, zitat) {
  const f = p(`snapshots/seiten/${quelleId}.md`);
  if (!existsSync(f)) return { status: 'dokument-fehlt' };
  return findInText(stripMd(readFileSync(f, 'utf8')), zitat);
}

export function jurisTeil(quelleId, teil) {
  const j = readJson(p(`snapshots/juris/${quelleId}.json`));
  if (!j) return null;
  const ts = j.teile.filter((x) => x.titel === teil || x.titel.startsWith(teil + ' '));
  return ts.find((x) => !/ - § \d/.test(x.titel)) || ts[0] || null;
}

export function findInJuris(quelleId, teil, zitat) {
  const j = readJson(p(`snapshots/juris/${quelleId}.json`));
  if (!j) return { status: 'dokument-fehlt' };
  const pool = teil ? j.teile.filter((x) => x.titel === teil || x.titel.startsWith(teil + ' ')) : j.teile;
  if (teil && !pool.length) return { status: 'teil-fehlt' };
  for (const x of pool) if (findInText(x.plain, zitat).status === 'ok') return { status: 'ok', teilId: x.id, teilTitel: x.titel };
  return { status: 'nicht-gefunden' };
}

/** Dokument-ID für ein Fach/Jahr auflösen. */
export function dokId(fach, pr, jahr) {
  const key = typeof pr.dok === 'object' ? pr.dok[jahr] : pr.dok;
  if (!key) return null;
  return `${jahr}-${fach.ordner}-${key}`;
}

/** Prüft alle Fakten; Ergebnis wird von build.mjs und verify.mjs verwendet. */
export function pruefeAlles() {
  const index = readJson(p('snapshots/index.json'), { quellen: {}, dokumente: {} });
  const fd = readYaml(p('data/faecher.yaml'));
  const td = readYaml(p('data/themen.yaml'));
  const report = { ok: 0, fehlt: 0, details: [] };
  const verfuegbareJahre = [...new Set(Object.values(index.dokumente).filter((d) => d.jahr && d.verlinkt !== false).map((d) => d.jahr))].sort();
  const jahre = verfuegbareJahre.length ? verfuegbareJahre : fd.jahre;

  for (const fach of fd.faecher) {
    for (const pr of fach.pruefungen) {
      pr._jahre = {};
      for (const jahr of jahre) {
        const id = dokId(fach, pr, jahr);
        const doc = id ? index.dokumente[id] : null;
        pr._jahre[jahr] = { dokId: id, vorhanden: !!doc, dok: doc || null };
      }
      for (const f of pr.fakten) {
        f._belege = {};
        for (const jahr of jahre) {
          const { dokId: id, vorhanden } = pr._jahre[jahr];
          let r;
          if (f.jahre && !f.jahre.includes(jahr)) r = { status: 'nicht-zutreffend' };
          else if (!id) r = { status: 'kein-dokument' };
          else if (!vorhanden) r = { status: 'dokument-fehlt' };
          else r = findInDoc(id, f.zitat);
          f._belege[jahr] = r;
          if (r.status === 'ok') report.ok++;
          else if (r.status === 'nicht-gefunden') { report.fehlt++; report.details.push(`${fach.slug} ${jahr} [${pr.titel}] „${f.thema}“: Zitat nicht gefunden in ${id}`); }
        }
      }
    }
  }
  for (const th of td.themen) {
    for (const f of th.fakten) {
      const q = index.quellen[f.quelle];
      let r;
      if (!q) r = { status: 'quelle-fehlt' };
      else if (q.typ === 'juris') r = findInJuris(f.quelle, f.teil, f.zitat);
      else if (q.typ === 'seite') r = findInSeite(f.quelle, f.zitat);
      else if (q.typ === 'pdf') r = findInDoc(f.quelle, f.zitat);
      else r = { status: 'unbekannt' };
      f._beleg = r;
      if (r.status === 'ok') report.ok++;
      else { report.fehlt++; report.details.push(`Thema ${th.id}: „${f.wert.slice(0, 60)}…“ → ${r.status} (${f.quelle} ${f.teil || ''})`); }
    }
  }
  return { faecher: fd, themen: td, index, report, jahre };
}

/** Prüft die redaktionellen Hinweise (data/hinweise.yaml). */
export function pruefeHinweise(index) {
  const hd = readYaml(p('data/hinweise.yaml'));
  for (const h of hd.hinweise) {
    for (const b of h.belege || []) {
      if (b.dok) b._beleg = index.dokumente[b.dok] ? findInDoc(b.dok, b.zitat) : { status: 'dokument-fehlt' };
      else {
        const q = index.quellen[b.quelle];
        if (!q) b._beleg = { status: 'quelle-fehlt' };
        else if (q.typ === 'juris') b._beleg = findInJuris(b.quelle, b.teil, b.zitat);
        else if (q.typ === 'seite') b._beleg = findInSeite(b.quelle, b.zitat);
        else b._beleg = findInDoc(b.quelle, b.zitat);
      }
    }
  }
  return hd.hinweise;
}
