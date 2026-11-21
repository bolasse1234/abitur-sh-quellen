#!/usr/bin/env node
// Erzeugt die statische Website in dist/ aus Schnappschüssen (snapshots/), Originaldateien
// (public/dateien/) und den belegten Kernangaben (data/*.yaml).
// Jede HTML-Seite erhält einen Markdown-Zwilling (index.md). Dazu: llms.txt, llms-full.txt,
// JSON-API (api/*.json), sitemap.xml, robots.txt, _headers.
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Marked } from 'marked';
import { p, readJson, readYaml, writeJson, writeText, deDate, deDateLong, slug, today } from './lib/util.mjs';
import { pruefeAlles, pruefeHinweise, jurisTeil } from './lib/belege.mjs';

const cfg = readJson(p('site.config.json'));
const SITE = (process.env.SITE_URL || cfg.url).replace(/\/$/, '');
const DIST = p('dist');

const { faecher: FD, themen: TD, index: IDX, report, jahre: JAHRE } = pruefeAlles();
const HINWEISE = pruefeHinweise(IDX);
const STAND = IDX.stand || today();
const TERMINE = readJson(p('snapshots/termine.json'), { jahre: [] });
const Q = (id) => IDX.quellen[id];
const D = (id) => IDX.dokumente[id];

// aktueller Abiturjahrgang: ab August zählt das Folgejahr
const heute = today();
const AKTUELL = Number(heute.slice(5, 7)) >= 8 ? Number(heute.slice(0, 4)) + 1 : Number(heute.slice(0, 4));
const JAHR_FOKUS = JAHRE.includes(AKTUELL) ? AKTUELL : JAHRE[0];

// ---------------------------------------------------------------------------
// Hilfsfunktionen

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const mdEsc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const zitatStr = (z) => (Array.isArray(z) ? z[0] : z);
const kv = (pairs) => pairs.filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `- **${k}:** ${v}`).join('\n') + '\n';
const docLink = (id) => `/dokumente/${id}/`;
const fileLink = (doc) => `/${doc.datei}`;
const abs = (path) => (path.startsWith('http') ? path : SITE + path);

function quelleOriginal(doc) {
  // liefert Angaben zum amtlichen Original eines gespiegelten Dokuments
  const q = Q(doc.quelle);
  if (!q) return {};
  if (q.typ === 'zip') return { landing: q.url, datei: q.zipUrl, dateiName: q.zipName, pfad: doc.pfadImZip, eltern: q.eltern ? Q(q.eltern) : null };
  if (q.typ === 'pdf') return { landing: q.eltern ? Q(q.eltern)?.url : q.url, datei: q.dateiUrl || q.url, eltern: q.eltern ? Q(q.eltern) : null };
  if (q.typ === 'juris') return { landing: q.url, datei: doc.originalUrl, eltern: q };
  return { landing: q.url };
}

function originalMd(doc) {
  const o = quelleOriginal(doc);
  const parts = [];
  if (o.datei) parts.push(`[Originaldatei${o.dateiName ? ` (${o.dateiName})` : ''}](${o.datei})`);
  if (o.landing) parts.push(`[Fundstelle beim Land](${o.landing})`);
  if (o.pfad) parts.push(`Pfad im ZIP: \`${o.pfad}\``);
  return parts.join(' · ');
}

function seiteAnker(r) {
  return r.seite ? `#seite-${r.seite}` : '';
}

function statusText(r, jahr, docId) {
  switch (r.status) {
    case 'ok': return null;
    case 'nicht-zutreffend': return null;
    case 'dokument-fehlt': return `Für ${jahr} ist im amtlichen ZIP der Prüfungsregelungen (Stand des Abrufs) kein passendes Dokument enthalten.`;
    case 'kein-dokument': return `Für ${jahr} ist kein entsprechendes Dokument zugeordnet.`;
    case 'nicht-gefunden': return `⚠ Im Dokument für ${jahr} (${docId}) wurde dieses Zitat nicht wortgleich gefunden – Regelung kann sich geändert haben. Bitte das Original prüfen.`;
    default: return `Status: ${r.status}`;
  }
}

// ---------------------------------------------------------------------------
// Seitenregister

const PAGES = [];
function addPage(path, { title, description, md, html = null, quellen = [], lastmod = STAND, typ = 'seite', inLlmsFull = true }) {
  PAGES.push({ path, title, description, md, html, quellen: [...new Set(quellen.filter(Boolean))], lastmod, typ, inLlmsFull });
}

const marked = new Marked({ gfm: true });
marked.use({
  renderer: {
    heading({ tokens, depth, text }) {
      const inner = this.parser.parseInline(tokens);
      let id;
      const m = text.match(/^§\s*(\d+[a-z]?)\b/);
      const a = text.match(/^Anlage\s+([\d.]+[a-z]?)/);
      const y = text.match(/^Abitur\s+(\d{4})$/);
      const s = text.match(/^Seite\s+(\d+)$/);
      if (m) id = `p${m[1]}`;
      else if (a) id = `anlage-${a[1].replace(/\./g, '-')}`;
      else if (y) id = `abitur-${y[1]}`;
      else if (s) id = `seite-${s[1]}`;
      else id = slug(text).slice(0, 60);
      return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${depth}>\n`;
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const ext = /^https?:/.test(href) && !href.startsWith(SITE);
      return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ''}${ext ? ' rel="noopener" class="ext"' : ''}>${inner}</a>`;
    },
  },
});

// ---------------------------------------------------------------------------
// Bausteine

function faktMd(f, r, jahr) {
  const st = statusText(r, jahr, r.dokId);
  if (r.status === 'nicht-zutreffend') return '';
  let s = `- **${f.thema}:** ${f.wert}\n`;
  if (r.status === 'ok') {
    const z = r.zitat || zitatStr(f.zitat);
    s += `  > „${z}“`;
    s += r.seite ? ` (S. ${r.seite}${r.tolerant ? '; Abgleich tolerant, da Textebene des PDFs fehlerhaft' : ''})` : '';
    s += '\n';
  } else if (st) {
    s += `  - ${st}\n`;
  }
  return s;
}

function dokZeile(doc) {
  if (!doc) return '';
  return `Dokument: [${doc.titel}](${docLink(doc.id)}) (${doc.seiten ? `${doc.seiten} S., ` : ''}[PDF-Kopie](${fileLink(doc)})) · ${originalMd(doc)} · abgerufen ${deDate(doc.abgerufen)}`;
}

function bearbeitungszeiten(jahr) {
  const rows = [];
  for (const fach of FD.faecher) {
    for (const pr of fach.pruefungen) {
      const doc = pr._jahre[jahr]?.dok;
      const zeiten = pr.fakten.filter((f) => /^Bearbeitungszeit/.test(f.thema) && f._belege[jahr]?.status === 'ok');
      if (!zeiten.length) {
        const fehlt = pr.fakten.some((f) => f._belege[jahr]?.status === 'dokument-fehlt');
        if (fehlt && pr.fakten.some((f) => /^Bearbeitungszeit/.test(f.thema))) rows.push({ fach, pr, text: 'kein Dokument für dieses Jahr im amtlichen ZIP', doc: null });
        continue;
      }
      for (const f of zeiten) {
        const r = f._belege[jahr];
        rows.push({ fach, pr, f, text: f.wert, doc, seite: r.seite, label: f.thema.replace(/^Bearbeitungszeit\s*/, '') });
      }
    }
  }
  return rows;
}

function bearbeitungszeitenTabelle(jahr) {
  const rows = bearbeitungszeiten(jahr);
  let md = `| Fach | Prüfung | Niveau | Bearbeitungszeit | Beleg |\n| --- | --- | --- | --- | --- |\n`;
  for (const r of rows) {
    const niveau = r.label && /^(eA|gA)$/.test(r.label) ? r.label : (r.label || r.pr.niveau.join('/'));
    md += `| [${r.fach.name}](/faecher/${r.fach.slug}/#abitur-${jahr}) | ${mdEsc(r.pr.titel)} | ${mdEsc(niveau)} | ${mdEsc(r.text)} | ${r.doc ? `[Dokument${r.seite ? `, S. ${r.seite}` : ''}](${docLink(r.doc.id)}${r.seite ? `#seite-${r.seite}` : ''})` : '–'} |\n`;
  }
  return md;
}

function termineTabelle(t) {
  let md = `| Termin | Prüfung |\n| --- | --- |\n`;
  for (const z of t.zeilen) md += `| ${mdEsc(z.termin)} | ${mdEsc(z.pruefung)} |\n`;
  if (t.stand) md += `\n*Angabe der Landesseite: „${t.stand}“*\n`;
  return md;
}

const qTermine = Q('za-termine');
function termineQuelleMd() {
  return `Quelle: [${qTermine?.titel}](${qTermine?.url}) · Seite zuletzt aktualisiert laut Land: ${deDate(qTermine?.letzteAktualisierung)} · abgerufen ${deDate(qTermine?.abgerufen)}`;
}

// ---------------------------------------------------------------------------
// Startseite

function startseite() {
  const tFokus = TERMINE.jahre.filter((t) => t.jahr >= AKTUELL);
  let md = `# Abitur in Schleswig-Holstein: amtliche Informationen, quellenbelegt\n\n`;
  md += `Diese Seite sammelt die **offiziellen Informationen des Landes Schleswig-Holstein** zu Oberstufe und Abitur an allgemeinbildenden Schulen – Prüfungstermine, Bearbeitungszeiten, Aufbau der Prüfungen je Fach und Niveau, Hilfsmittel sowie die zugrunde liegenden Verordnungen. Jede Angabe ist mit einem **wörtlichen Zitat**, der **Fundstelle** und dem **Abrufdatum** belegt; die amtlichen Texte sind im Volltext gespiegelt.\n\n`;
  md += `> **Inoffizielle Zusammenstellung, ohne Gewähr. Stand: ${deDate(STAND)}.** Kein Angebot des Landes Schleswig-Holstein. Verbindlich sind ausschließlich die verlinkten Originale.\n\n`;
  md += `## Abitur ${JAHR_FOKUS} auf einen Blick\n\n`;
  for (const t of tFokus.slice(0, 1)) md += `### Prüfungstermine ${t.jahr}\n\n${termineTabelle(t)}\n${termineQuelleMd()}\n\nWeitere Jahrgänge: [alle Prüfungstermine](/termine/)\n\n`;
  md += `### Bearbeitungszeiten der schriftlichen Prüfungen ${JAHR_FOKUS}\n\n${bearbeitungszeitenTabelle(JAHR_FOKUS)}\nAndere Jahrgänge: ${JAHRE.map((j) => `[${j}](/faecher/#abitur-${j})`).join(' · ')}\n\n`;
  md += `## Inhalte\n\n`;
  md += `- [Prüfungstermine](/termine/) – zentrale Termine je Abiturjahr\n`;
  md += `- [Fächer](/faecher/) – Bearbeitungszeit, Aufbau, Auswahl, Hilfsmittel je Fach, Niveau und Jahrgang:\n  ${FD.faecher.map((f) => `[${f.name}](/faecher/${f.slug}/)`).join(' · ')}\n`;
  md += `- [Oberstufe & Abiturprüfung](/oberstufe/) – Aufbau der Prüfung, Prüfungszeiten, mündliche Prüfung, Präsentationsprüfung (OAPVO)\n`;
  md += `- [Rechtsgrundlagen](/recht/) – OAPVO, APVO-EW, AGVO, BGVO im Volltext\n`;
  md += `- [Amtliche Dokumente](/dokumente/) – fachspezifische Prüfungsregelungen ${JAHRE.join(', ')}, Erlasse, FAQ, Broschüre (Textspiegel + PDF-Kopie)\n`;
  md += `- [Prüfungsaufgaben](/aufgaben/) – nur Links auf die Originale (urheberrechtlich geschützt)\n`;
  md += `- [Fachanforderungen](/fachanforderungen/) – Lehrpläne der Oberstufe (Links)\n`;
  md += `- [Lücken & Unklarheiten](/hinweise/) – was fehlt, was sich unterscheidet\n`;
  md += `- [Quellen & Abrufdaten](/quellen/) – alle Originalquellen mit Abrufdatum und Prüfsumme\n`;
  md += `- [Über diese Seite / für KI-Agenten](/ueber/) – Methodik, Zitierhinweise, Aktualisierung, Maschinenschnittstellen\n\n`;
  md += `## Für KI-Agenten und Suchmaschinen\n\n`;
  md += `Alle Seiten gibt es zusätzlich als Markdown (\`index.md\` im selben Pfad). Übersicht: [/llms.txt](/llms.txt), Volltext: [/llms-full.txt](/llms-full.txt), strukturierte Daten: [/api/index.json](/api/index.json). Bitte beim Zitieren immer die **amtliche Originalquelle** nennen, die zu jeder Angabe verlinkt ist.\n`;
  addPage('/', { title: 'Abitur in Schleswig-Holstein – amtliche Informationen, quellenbelegt', description: `Inoffizielle, quellenbelegte Zusammenstellung: Prüfungstermine, Bearbeitungszeiten und Aufbau der Abiturprüfungen je Fach und Niveau in Schleswig-Holstein. Stand ${deDate(STAND)}.`, md, quellen: [qTermine?.url, Q('za-regelungen')?.url] });
}

// ---------------------------------------------------------------------------
// Termine

function terminseite() {
  let md = `# Prüfungstermine Abitur Schleswig-Holstein (allgemeinbildende Schulen)\n\n`;
  md += `${termineQuelleMd()}\n\n`;
  md += `Die Tabellen werden bei jeder Aktualisierung automatisch aus der Landesseite ausgelesen.\n\n`;
  for (const t of TERMINE.jahre) md += `## Abitur ${t.jahr}\n\n${termineTabelle(t)}\n`;
  if (!TERMINE.jahre.length) md += `Auf der Landesseite wurden beim letzten Abruf keine Termintabellen gefunden.\n`;
  md += `\n## Rahmen laut OAPVO\n\n`;
  for (const f of TD.themen.find((t) => t.id === 'termine-regeln')?.fakten || []) md += themaFaktMd(f);
  const f16 = TD.themen.find((t) => t.id === 'zeiten')?.fakten.find((f) => f.teil === '§ 16');
  if (f16) md += themaFaktMd(f16);
  addPage('/termine/', { title: 'Prüfungstermine Abitur Schleswig-Holstein', description: `Termine der schriftlichen und mündlichen Abiturprüfungen ${TERMINE.jahre.map((t) => t.jahr).join(', ')} in Schleswig-Holstein laut Landesseite, mit Quelle und Abrufdatum.`, md, quellen: [qTermine?.url, Q('oapvo')?.url] });
}

// ---------------------------------------------------------------------------
// Themen (OAPVO etc.)

function themaFaktMd(f) {
  const q = Q(f.quelle);
  let link = q?.url;
  let label = q?.kurz || q?.titel || f.quelle;
  if (q?.typ === 'juris') { link = `/recht/${f.quelle}/#${f.teil ? 'p' + f.teil.replace(/^§\s*/, '') : ''}`; label = `${f.teil} ${q.kurz || ''}`.trim(); }
  else if (q?.typ === 'seite') link = `/seiten/${f.quelle}/`;
  const r = f._beleg || {};
  let s = `- **${f.wert}**\n`;
  if (r.status === 'ok') s += `  > „${r.zitat || zitatStr(f.zitat)}“\n  > — [${label}](${link})${q?.typ === 'juris' ? ` ([Original juris](${q.url}))` : q?.url ? ` ([Original](${q.url}))` : ''}, abgerufen ${deDate(q?.abgerufen)}\n`;
  else s += `  - ⚠ Beleg im aktuellen Stand der Quelle nicht gefunden (${r.status}). Bitte [Original](${q?.url}) prüfen.\n`;
  return s;
}

function oberstufenseite() {
  let md = `# Oberstufe und Abiturprüfung in Schleswig-Holstein – Kernregeln\n\n`;
  md += `Wörtlich belegte Kernregeln aus der [OAPVO](/recht/oapvo/) und den Landesseiten. Vollständige Regeln: siehe Volltexte unter [Rechtsgrundlagen](/recht/).\n\n`;
  for (const th of TD.themen) {
    md += `## ${th.titel}\n\n`;
    for (const f of th.fakten) md += themaFaktMd(f);
    md += `\n`;
  }
  const quellen = [...new Set(TD.themen.flatMap((t) => t.fakten.map((f) => Q(f.quelle)?.url)))];
  addPage('/oberstufe/', { title: 'Oberstufe und Abiturprüfung – Kernregeln (OAPVO)', description: 'Aufbau der Abiturprüfung, Prüfungsfächer, Prüfungszeiten, Sprechprüfung, mündliche Prüfung und Präsentationsprüfung in Schleswig-Holstein – wörtlich belegt.', md, quellen });
}

// ---------------------------------------------------------------------------
// Fächer

function fachDokumente(fach, jahr) {
  return Object.values(IDX.dokumente).filter((d) => d.jahr === jahr && d.fach === fach.ordner && d.verlinkt !== false).sort((a, b) => a.dateiname.localeCompare(b.dateiname));
}

function fachseite(fach) {
  let md = `# ${fach.name} – Abiturprüfung in Schleswig-Holstein\n\n`;
  md += `Allgemeinbildende Schulen (Gymnasien, Gemeinschaftsschulen mit Oberstufe; teils auch APVO-EW/AGVO, siehe Dokumente). Grundlage: fachspezifische Prüfungsregelungen des Landes für die Abiturjahrgänge ${JAHRE.join(', ')}.\n\n`;
  // Kurzübersicht
  md += `## Kurzüberblick Bearbeitungszeiten\n\n| Prüfung | Angabe | ${JAHRE.join(' | ')} |\n| --- | --- | ${JAHRE.map(() => '---').join(' | ')} |\n`;
  for (const pr of fach.pruefungen) {
    for (const thema of [...new Set(pr.fakten.filter((f) => /^Bearbeitungszeit|^Prüfungsteile/.test(f.thema)).map((f) => f.thema))]) {
      const cells = JAHRE.map((j) => {
        const f = pr.fakten.find((x) => x.thema === thema && x._belege[j]?.status === 'ok');
        if (f) return mdEsc(f.wert);
        const any = pr.fakten.find((x) => x.thema === thema);
        const st = any?._belege[j]?.status;
        return st === 'dokument-fehlt' ? 'kein Dokument' : st === 'nicht-gefunden' ? '⚠ nicht belegt' : '–';
      });
      md += `| ${mdEsc(pr.titel)} | ${thema} | ${cells.join(' | ')} |\n`;
    }
  }
  md += `\n`;
  // Termine, die das Fach namentlich nennen
  const tz = TERMINE.jahre.flatMap((t) => t.zeilen.filter((z) => z.pruefung.includes(fach.name)).map((z) => ({ ...z, jahr: t.jahr })));
  if (tz.length) {
    md += `## Termine (Zeilen der Landes-Termintabelle, die ${fach.name} nennen)\n\n| Jahr | Termin | Prüfung |\n| --- | --- | --- |\n`;
    for (const z of tz) md += `| ${z.jahr} | ${mdEsc(z.termin)} | ${mdEsc(z.pruefung)} |\n`;
    md += `\nVollständige Tabellen (auch Profilfächer, mündliche Prüfungen): [Prüfungstermine](/termine/). ${termineQuelleMd()}\n\n`;
  } else {
    md += `## Termine\n\nDie Termintabelle des Landes nennt ${fach.name} nicht namentlich; Termine für Profilfächer und mündliche Prüfungen siehe [Prüfungstermine](/termine/).\n\n`;
  }
  // je Jahr
  for (const jahr of JAHRE) {
    const zip = Q(`pruefungsregelungen-${jahr}`);
    md += `## Abitur ${jahr}\n\n`;
    if (zip) md += `Quelle: [${zip.titel}](${zip.url}) (Originaldatei: [${zip.zipName}](${zip.zipUrl})) · abgerufen ${deDate(zip.abgerufen)}\n\n`;
    for (const pr of fach.pruefungen) {
      const info = pr._jahre[jahr];
      md += `### ${pr.titel} – ${jahr}\n\n`;
      if (!info?.dok) {
        md += `${statusText({ status: info?.dokId ? 'dokument-fehlt' : 'kein-dokument' }, jahr)}\n\n`;
        continue;
      }
      md += `${dokZeile(info.dok)}\n\n`;
      for (const f of pr.fakten) {
        const r = { ...f._belege[jahr], dokId: info.dokId };
        const fm = faktMd(f, r, jahr);
        if (fm) md += fm.replace(/\(S\. (\d+)/, `([S. $1](${docLink(info.dokId)}#seite-$1)`);
      }
      md += `\n`;
    }
    const docs = fachDokumente(fach, jahr);
    if (docs.length) {
      md += `**Alle amtlichen Dateien „${fach.name}“ im ZIP ${jahr}:** ` + docs.map((d) => `[${d.dateiname}](${d.text ? docLink(d.id) : fileLink(d)})`).join(' · ') + `\n\n`;
    }
  }
  // Fachanforderungen & Aufgaben
  const fa = Object.values(IDX.quellen).find((q) => q.fach === fach.slug);
  md += `## Fachanforderungen (Lehrplan)\n\n`;
  md += fa ? `Seite des IQSH-Fachportals: [${fa.titel}](${fa.url}) · Textspiegel: [/seiten/${fa.id}/](/seiten/${fa.id}/) · abgerufen ${deDate(fa.abgerufen)}. Die PDF-Dokumente der Fachanforderungen werden nur verlinkt.\n\n` : `Keine Fachportal-Seite zugeordnet.\n\n`;
  md += `## Prüfungsaufgaben früherer Jahre\n\nDie zentral gestellten Prüfungsaufgaben werden aus urheberrechtlichen Gründen **nur verlinkt**: [Prüfungsaufgaben](/aufgaben/).\n`;
  const quellen = [fa?.url, ...JAHRE.map((j) => Q(`pruefungsregelungen-${j}`)?.url), qTermine?.url];
  addPage(`/faecher/${fach.slug}/`, { title: `${fach.name}: Abiturprüfung Schleswig-Holstein – Bearbeitungszeit, Aufbau, Hilfsmittel`, description: `${fach.name} im Abitur Schleswig-Holstein ${JAHRE.join('/')}: Bearbeitungszeiten, Aufbau und Auswahl der Aufgaben, Hilfsmittel je Niveau – mit wörtlichen Belegen aus den amtlichen Prüfungsregelungen.`, md, quellen });
}

function faecheruebersicht() {
  let md = `# Fächer im Abitur Schleswig-Holstein – Bearbeitungszeiten je Fach und Niveau\n\n`;
  md += `Übersicht der schriftlichen Prüfungen nach den fachspezifischen Prüfungsregelungen des Landes. Details, Aufbau, Auswahl und Hilfsmittel auf den Fachseiten. Jede Zeile verweist auf das amtliche Dokument mit Seitenangabe.\n\n`;
  const fz = TD.themen.find((t) => t.id === 'faecher-zentral');
  if (fz) { md += `## Prüfungsfächer und zentral geprüfte Fächer\n\n`; for (const f of fz.fakten) md += themaFaktMd(f); md += `\n`; }
  for (const jahr of JAHRE) md += `## Abitur ${jahr}\n\n${bearbeitungszeitenTabelle(jahr)}\n`;
  md += `## Fachseiten\n\n${FD.faecher.map((f) => `- [${f.name}](/faecher/${f.slug}/)`).join('\n')}\n`;
  addPage('/faecher/', { title: 'Fächer: Bearbeitungszeiten im Abitur Schleswig-Holstein', description: `Bearbeitungszeiten der schriftlichen Abiturprüfungen in Schleswig-Holstein je Fach und Niveau (${JAHRE.join(', ')}), belegt mit den amtlichen Prüfungsregelungen.`, md, quellen: JAHRE.map((j) => Q(`pruefungsregelungen-${j}`)?.url) });
}

// ---------------------------------------------------------------------------
// Rechtsgrundlagen (juris)

function rechtsseiten() {
  const normen = Object.values(IDX.quellen).filter((q) => q.typ === 'juris' && existsSync(p(`snapshots/juris/${q.id}.json`)));
  let ov = `# Rechtsgrundlagen Oberstufe und Abitur (Schleswig-Holstein)\n\n`;
  ov += `Konsolidierte Fassungen aus dem amtlichen Portal „Landesrecht Schleswig-Holstein – Bürgerservice“ (gesetze-rechtsprechung.sh.juris.de), im Volltext gespiegelt.\n\n`;
  ov += `| Kurz | Verordnung | Stand laut Portal | abgerufen |\n| --- | --- | --- | --- |\n`;
  for (const q of normen) {
    const j = readJson(p(`snapshots/juris/${q.id}.json`));
    ov += `| [${q.kurz || q.id}](/recht/${q.id}/) | ${mdEsc(j.titel)} | ${mdEsc(j.stand || '–')} | ${deDate(q.abgerufen)} |\n`;
    let md = `# ${j.titel}\n\n`;
    md += kv([['Amtliche Abkürzung', j.kopf?.amtlicheAbkuerzung || q.kurz], ['Ausfertigungsdatum', j.kopf?.ausfertigungsdatum], ['Gültig ab', j.kopf?.gueltigAb], ['Fundstelle', j.kopf?.fundstelle], ['Stand laut Portal', j.stand], ['Original (jeweils geltende Fassung)', `[${j.permalink}](${j.permalink})`], ['abgerufen', deDate(q.abgerufen)]]);
    if (q.hinweis) md += `\n> Hinweis: ${q.hinweis}\n`;
    md += `\n*Nichtamtliche Wiedergabe der konsolidierten Fassung aus dem Landesrecht-Portal. Verbindlich ist die im Nachrichtenblatt verkündete Fassung.*\n\n`;
    md += `## Inhaltsübersicht\n\n` + j.teile.filter((t) => /^(§|Anlage)/.test(t.titel)).map((t) => {
      const m = t.titel.match(/^§\s*(\d+[a-z]?)/); const a = t.titel.match(/^Anlage\s+([\d.]+[a-z]?)/);
      if (/ - § \d/.test(t.titel)) return null;
      const id = m ? `p${m[1]}` : a ? `anlage-${a[1].replace(/\./g, '-')}` : slug(t.titel);
      return `- [${t.titel}](#${id})`;
    }).filter(Boolean).join('\n') + `\n\n`;
    const anl = Object.values(IDX.dokumente).filter((d) => d.quelle === q.id && d.verlinkt !== false);
    for (const t of j.teile) {
      if (t.titel === 'Inhaltsverzeichnis') continue;
      let body = (t.markdown || '').trim();
      const level = Math.min(2 + Math.max(0, t.ebene - 1), 4);
      body = body.replace(/^#{1,6}\s+(.+)$/gm, (mm, h) => `${'#'.repeat(level)} ${h.replace(/\s+/g, ' ')}`);
      if (!/^#/.test(body)) body = `${'#'.repeat(level)} ${t.titel}\n\n${body}`;
      body = body.replace(/\(Anlage als PDF – siehe Link\)/g, () => {
        const d = anl.find((x) => x.titel.includes(t.titel.split(' - ')[0]));
        return d ? `(Anlage als PDF: [Kopie](${fileLink(d)}) · [Original](${d.originalUrl}))` : '(Anlage als PDF im Original)';
      });
      md += body + `\n\n`;
    }
    addPage(`/recht/${q.id}/`, { title: `${q.kurz || q.id}: ${j.titel.replace(/\s+vom .*$/i, '')} – Volltext`, description: `Volltext der ${q.kurz || q.id} (Schleswig-Holstein), Stand laut Landesrecht-Portal: ${j.stand || 'k. A.'}. Abgerufen ${deDate(q.abgerufen)}.`, md, quellen: [j.permalink], typ: 'recht' });
  }
  addPage('/recht/', { title: 'Rechtsgrundlagen Oberstufe und Abitur', description: 'OAPVO, APVO-EW, AGVO und BGVO im Volltext mit Stand und Abrufdatum.', md: ov, quellen: normen.map((q) => q.url) });
}

// ---------------------------------------------------------------------------
// Dokumente (Textspiegel)

function dokumentseiten() {
  const docs = Object.values(IDX.dokumente).filter((d) => d.text);
  for (const d of docs) {
    const layoutFile = p(`snapshots/dokumente/${d.id}.layout.txt`);
    const raw = readFileSync(existsSync(layoutFile) ? layoutFile : p(d.text), 'utf8')
      .replace(/\ufb03/g, 'ffi').replace(/\ufb04/g, 'ffl').replace(/\ufb00/g, 'ff').replace(/\ufb01/g, 'fi').replace(/\ufb02/g, 'fl');
    const pages = raw.split('\f').map((pg) => {
      const lines = pg.split('\n').map((l) => l.replace(/\s+$/, ''));
      const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
      return lines.map((l) => l.slice(Number.isFinite(ind) ? ind : 0).replace(/ {4,}/g, '   ')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    });
    while (pages.length && !pages[pages.length - 1]) pages.pop();
    const ligaturDefekt = /\p{L}[0-9]\p{L}|hilfsmi elf/u.test(raw) || /[\ufb00-\ufb06]/.test(readFileSync(p(d.text), 'utf8'));
    const o = quelleOriginal(d);
    const q = Q(d.quelle);
    let head = `# ${d.titel}\n\n`;
    head += kv([
      ['Abiturjahrgang', d.jahr],
      ['Fach (Ordner im ZIP)', d.fachOrdner],
      ['Herausgeber', IDX_HERAUSGEBER(q)],
      ['Originaldatei', o.datei ? `[${o.dateiName || 'Download'}](${o.datei})` : null],
      ['Pfad im ZIP', o.pfad ? `\`${o.pfad}\`` : null],
      ['Fundstelle beim Land', o.landing ? `[${o.eltern?.titel || q?.titel || o.landing}](${o.landing})` : null],
      ['Kopie der Datei', `[${d.dateiname}](${fileLink(d)}) (${Math.round(d.groesse / 1024)} KB${d.seiten ? `, ${d.seiten} Seiten` : ''})`],
      ['abgerufen', deDate(d.abgerufen)],
      ['SHA-256', `\`${d.sha256.slice(0, 16)}…\``],
      ['Status', d.verlinkt === false ? '⚠ beim letzten Abruf nicht mehr in der Originalquelle enthalten' : null],
    ]);
    head += `\n*Text maschinell aus dem PDF extrahiert (pdftotext). Tabellen, Hervorhebungen und Layout können abweichen; maßgeblich ist das Original-PDF.*\n`;
    if (ligaturDefekt) head += `\n> ⚠ Die Textebene dieses Original-PDFs ist fehlerhaft: Buchstabenverbindungen (z. B. „tt“, „ti“, „ft“) fehlen in der Extraktion oder sind durch Ziffern ersetzt. Bitte das PDF selbst ansehen.\n`;
    const md = head + `\n` + pages.map((pg, i) => `## Seite ${i + 1}\n\n${pg}\n`).join('\n');
    const html = marked.parse(head) + pages.map((pg, i) => `<h2 id="seite-${i + 1}"><a class="anchor" href="#seite-${i + 1}" aria-hidden="true">#</a>Seite ${i + 1}</h2>\n<pre class="doc">${esc(pg)}</pre>`).join('\n');
    addPage(docLink(d.id), { title: `${d.titel}${d.jahr && !String(d.titel).includes(String(d.jahr)) ? ` (Abitur ${d.jahr})` : ''} – Textspiegel`, description: `Textspiegel des amtlichen Dokuments „${d.titel}“${d.jahr ? ` (Abitur ${d.jahr})` : ''} mit Link zum Original. Abgerufen ${deDate(d.abgerufen)}.`, md, html, quellen: [o.datei, o.landing], typ: 'dokument', lastmod: d.geaendert || d.abgerufen, inLlmsFull: false });
  }
  // Übersicht
  let md = `# Amtliche Dokumente (Textspiegel und Kopien)\n\nAmtliche Hinweise, Erlasse und Prüfungsregelungen des Landes Schleswig-Holstein – gespiegelt als Text und als Kopie der Originaldatei. Prüfungsaufgaben und Erwartungshorizonte sind **nicht** enthalten (siehe [Prüfungsaufgaben](/aufgaben/)).\n\n`;
  for (const jahr of JAHRE) {
    const zip = Q(`pruefungsregelungen-${jahr}`);
    md += `## Fachspezifische Prüfungsregelungen Abitur ${jahr}\n\n`;
    if (zip) md += `Original: [${zip.zipName}](${zip.zipUrl}) · Fundstelle: [${Q('za-regelungen')?.titel}](${zip.url}) · ${zip.anzahlDateien} Dateien · abgerufen ${deDate(zip.abgerufen)}\n\n`;
    const byFach = {};
    for (const d of Object.values(IDX.dokumente).filter((x) => x.jahr === jahr)) (byFach[d.fachOrdner] ||= []).push(d);
    for (const f of Object.keys(byFach).sort()) {
      md += `- **${f}:** ` + byFach[f].sort((a, b) => a.dateiname.localeCompare(b.dateiname)).map((d) => `[${d.dateiname}](${d.text ? docLink(d.id) : fileLink(d)})${d.verlinkt === false ? ' (nicht mehr im ZIP)' : ''}`).join(' · ') + `\n`;
    }
    md += `\n`;
  }
  md += `## Weitere amtliche Dokumente\n\n`;
  for (const d of Object.values(IDX.dokumente).filter((x) => !x.jahr)) md += `- [${d.titel}](${d.text ? docLink(d.id) : fileLink(d)}) – abgerufen ${deDate(d.abgerufen)}\n`;
  addPage('/dokumente/', { title: 'Amtliche Dokumente zum Abitur Schleswig-Holstein', description: `Fachspezifische Prüfungsregelungen ${JAHRE.join(', ')}, Erlasse, FAQ und Broschüre zur Oberstufe – Textspiegel mit Link zum Original.`, md, quellen: JAHRE.map((j) => Q(`pruefungsregelungen-${j}`)?.url) });
}

function IDX_HERAUSGEBER(q) {
  const reg = readYaml(p('sources/sources.yaml'));
  return reg.herausgeber[q?.herausgeber] || q?.herausgeber || '–';
}

// ---------------------------------------------------------------------------
// Gespiegelte Webseiten

function seitenspiegel() {
  for (const q of Object.values(IDX.quellen).filter((x) => x.typ === 'seite')) {
    const f = p(`snapshots/seiten/${q.id}.md`);
    if (!existsSync(f)) continue;
    const body = readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->\n?/g, '').replace(/^# Thema : .*\n+/m, '').replace(/^#\s/m, '## ');
    let md = `# ${q.seitentitel || q.titel} (Textspiegel)\n\n`;
    md += kv([['Original', `[${q.url}](${q.url})`], ['Herausgeber', IDX_HERAUSGEBER(q)], ['Letzte Aktualisierung laut Seite', q.letzteAktualisierung ? deDate(q.letzteAktualisierung) : 'nicht angegeben'], ['abgerufen', deDate(q.abgerufen)], ['Inhalt zuletzt geändert (lt. Abruf)', deDate(q.geaendert)]]);
    if (q.hinweis) md += `\n> Hinweis: ${q.hinweis}\n`;
    md += `\n*Wiedergabe des Seitentextes zum Abrufzeitpunkt. Verbindlich ist die Originalseite.*\n\n---\n\n${body}\n`;
    addPage(`/seiten/${q.id}/`, { title: `${q.seitentitel || q.titel} – Textspiegel`, description: `Textspiegel der Seite „${q.seitentitel || q.titel}“ (${new URL(q.url).hostname}), abgerufen ${deDate(q.abgerufen)}.`, md, quellen: [q.url], typ: 'seite-spiegel', lastmod: q.geaendert || q.abgerufen, inLlmsFull: !q.id.startsWith('fa-') });
  }
}

// ---------------------------------------------------------------------------
// Aufgaben (nur Links), Fachanforderungen, Quellen, Hinweise, Über

function aufgabenseite() {
  const qa = Q('za-aufgaben');
  let md = `# Prüfungsaufgaben Abitur Schleswig-Holstein (nur Links)\n\n`;
  md += `Prüfungsaufgaben und Erwartungshorizonte werden hier **nicht gespiegelt**, sondern nur verlinkt. Das Land stellt die Aufgaben der zentral geprüften Fächer der jeweils letzten fünf Jahre als ZIP-Dateien bereit.\n\n`;
  md += `Fundstelle: [${qa?.titel}](${qa?.url}) · abgerufen ${deDate(qa?.abgerufen)}\n\n| Jahr | Downloadseite | ZIP-Datei |\n| --- | --- | --- |\n`;
  for (const q of Object.values(IDX.quellen).filter((x) => x.id.startsWith('pruefungsaufgaben-')).sort((a, b) => b.jahr - a.jahr)) {
    md += `| ${q.jahr} | [Downloadseite](${q.url}) | ${q.zipUrl ? `[${q.zipName}](${q.zipUrl})` : '–'}${q.verlinkt === false ? ' (nicht mehr verlinkt)' : ''} |\n`;
  }
  md += `\nAus der Landesseite (wörtlich): Die Dokumente enthalten Materialien teils unkenntlich gemacht, „an denen das Ministerium … keine Verwertungsrechte besitzt“ – siehe [Textspiegel der Seite](/seiten/za-aufgaben/).\n\n`;
  md += `Für Aufgaben aus dem Gemeinsamen Abituraufgabenpool der Länder verweist die Landesseite auf das IQB: [Abituraufgabenpools](https://www.iqb.hu-berlin.de/de/schule/sekundarstufe-ii/abituraufgabenpools/).\n`;
  addPage('/aufgaben/', { title: 'Prüfungsaufgaben Abitur Schleswig-Holstein – Links zu den Originalen', description: 'Links zu den amtlichen Prüfungsaufgaben (ZIP) der zentral geprüften Fächer im Abitur Schleswig-Holstein.', md, quellen: [qa?.url] });
}

function fachanforderungenseite() {
  const qf = Q('fachanforderungen');
  let md = `# Fachanforderungen (Lehrpläne) für die Abiturfächer\n\nDie Fachanforderungen des IQSH-Fachportals sind Lehrpläne im Sinne des Schulgesetzes. Wegen ihres Umfangs werden die PDF-Dokumente **nur verlinkt**; die Texte der Fachportal-Seiten (mit allen Geltungshinweisen und Download-Links) sind gespiegelt.\n\nÜbersicht im Original: [${qf?.titel}](${qf?.url}) · abgerufen ${deDate(qf?.abgerufen)} · [Textspiegel](/seiten/fachanforderungen/)\n\n| Fach | Fachportal (Original) | Textspiegel | abgerufen |\n| --- | --- | --- | --- |\n`;
  for (const fach of FD.faecher) {
    const fa = Object.values(IDX.quellen).find((q) => q.fach === fach.slug);
    if (fa) md += `| ${fach.name} | [${fa.url}](${fa.url}) | [ansehen](/seiten/${fa.id}/) | ${deDate(fa.abgerufen)} |\n`;
  }
  addPage('/fachanforderungen/', { title: 'Fachanforderungen (Lehrpläne) der Abiturfächer – Links', description: 'Links zu den Fachanforderungen des IQSH-Fachportals für alle Abiturprüfungsfächer in Schleswig-Holstein.', md, quellen: [qf?.url] });
}

function quellenseite() {
  const reg = readYaml(p('sources/sources.yaml'));
  const qs = Object.values(IDX.quellen).sort((a, b) => a.id.localeCompare(b.id));
  let md = `# Quellen und Abrufdaten\n\n`;
  md += `Alle Angaben dieser Seite stammen ausschließlich aus den folgenden **offiziellen Quellen des Landes Schleswig-Holstein**. „abgerufen“ = letzter erfolgreicher Abruf; „geändert“ = letzter Abruf, bei dem sich der Inhalt (SHA-256) geändert hat.\n\n`;
  md += `**Gesamtstand: ${deDate(STAND)}** (ältestes Abrufdatum aller aktiven Quellen) · letzter Abruflauf: ${IDX.letzterLauf ? deDate(IDX.letzterLauf) : '–'}\n\n`;
  for (const [typ, label] of [['seite', 'Webseiten'], ['juris', 'Verordnungen (Landesrecht-Portal)'], ['zip', 'ZIP-Archive (gespiegelt)'], ['pdf', 'PDF-Dateien (gespiegelt)'], ['link', 'Nur verlinkt']]) {
    const rows = qs.filter((q) => q.typ === typ);
    if (!rows.length) continue;
    md += `## ${label}\n\n| Quelle | Herausgeber | Nutzung | abgerufen | geändert | Status |\n| --- | --- | --- | --- | --- | --- |\n`;
    for (const q of rows) {
      const st = q.status === 'ok' ? (q.verlinkt === false ? 'nicht mehr verlinkt' : 'ok') : `Fehler: ${mdEsc(q.fehler || '')}`;
      md += `| [${mdEsc(q.titel)}](${q.url})${q.zipUrl && q.typ !== 'link' ? ` ([ZIP](${q.zipUrl}))` : ''}${q.dateiUrl ? ` ([Datei](${q.dateiUrl}))` : ''} | ${mdEsc(reg.herausgeber[q.herausgeber] || q.herausgeber || '')} | ${q.nutzung} | ${deDate(q.abgerufen)} | ${deDate(q.geaendert)} | ${st} |\n`;
    }
    md += `\n`;
  }
  md += `Maschinenlesbar: [/api/quellen.json](/api/quellen.json)\n`;
  addPage('/quellen/', { title: 'Quellen und Abrufdaten', description: 'Alle offiziellen Quellen mit Abrufdatum, Änderungsdatum und Status.', md, quellen: qs.map((q) => q.url) });
}

function hinweisseite() {
  let md = `# Lücken, Unklarheiten und unterschiedliche Angaben\n\n`;
  md += `Was in den offiziellen Quellen fehlt, sich unterscheidet oder technisch nicht sauber auswertbar war. Nichts davon wird hier interpretiert oder aufgelöst – maßgeblich sind die Originale.\n\n`;
  md += `## Automatisch erkannt\n\n`;
  const auto = [];
  for (const fach of FD.faecher) for (const pr of fach.pruefungen) for (const jahr of JAHRE) {
    const info = pr._jahre[jahr];
    if (info?.dokId && !info.vorhanden) auto.push(`- **Dokument fehlt:** ${fach.name}, „${pr.titel}“, Abitur ${jahr} – im amtlichen ZIP der Prüfungsregelungen ${jahr} war beim Abruf am ${deDate(Q(`pruefungsregelungen-${jahr}`)?.abgerufen)} kein entsprechendes Dokument enthalten.`);
  }
  const fachOrdnerJahre = {};
  for (const d of Object.values(IDX.dokumente)) if (d.jahr) (fachOrdnerJahre[d.fach] ||= new Set()).add(d.jahr);
  for (const fach of FD.faecher) {
    const fehlend = JAHRE.filter((j) => !fachOrdnerJahre[fach.ordner]?.has(j));
    if (fehlend.length) auto.push(`- **Fachordner fehlt:** Im ZIP der Prüfungsregelungen ${fehlend.join(', ')} gibt es keinen Ordner „${fach.name}“, obwohl die Landesseite ${fach.name} als Abiturprüfungsfach nennt.`);
  }
  for (const d of Object.values(IDX.dokumente).filter((x) => x.text && existsSync(p(x.text)))) {
    const t = readFileSync(p(d.text), 'utf8');
    if (/[\ufb00-\ufb06]/.test(t) && /\p{L}[0-9]\p{L}|\p{Ll} \p{Ll}{1,2}\b/u.test(t) && d.jahr) auto.push(`- **Fehlerhafte Textebene im Original-PDF:** [${d.dateiname}](${docLink(d.id)}) (${d.jahr}) – Ligaturen fehlen in der Textextraktion; Zitate wurden tolerant abgeglichen.`);
  }
  for (const q of Object.values(IDX.quellen)) {
    if (q.hinweis && q.typ === 'juris') auto.push(`- **${q.kurz || q.id}:** ${q.hinweis}`);
    if (q.status === 'fehler') auto.push(`- **Abruffehler:** ${q.titel} (${q.url}): ${q.fehler} – es gilt der Stand vom ${deDate(q.abgerufen)}.`);
    if (q.verlinkt === false) auto.push(`- **Nicht mehr verlinkt:** ${q.titel} – seit ${deDate(q.nichtMehrVerlinktSeit)} nicht mehr auf der Originalseite.`);
  }
  for (const pr of IDX.probleme || []) auto.push(`- **Abrufproblem:** ${mdEsc(pr)}`);
  for (const d of report.details) auto.push(`- **Beleg nicht gefunden:** ${mdEsc(d)}`);
  md += (auto.length ? [...new Set(auto)].join('\n') : 'Keine.') + `\n\n`;
  md += `## Redaktionelle Hinweise\n\n`;
  for (const h of HINWEISE) {
    md += `### ${h.titel}\n\n*${h.typ}*\n\n${h.text}\n\n`;
    for (const b of h.belege || []) {
      let link, label;
      if (b.dok) { const d = D(b.dok); link = docLink(b.dok) + seiteAnker(b._beleg); label = d?.titel || b.dok; }
      else { const q = Q(b.quelle); link = q?.typ === 'juris' ? `/recht/${b.quelle}/#p${(b.teil || '').replace(/^§\s*/, '')}` : `/seiten/${b.quelle}/`; label = `${b.teil ? b.teil + ' ' : ''}${q?.kurz || q?.titel || b.quelle}`; }
      md += b._beleg?.status === 'ok' ? `> „${b.zitat}“ — [${label}](${link})${b._beleg.seite ? `, S. ${b._beleg.seite}` : ''}\n\n` : `- ⚠ Beleg derzeit nicht gefunden (${b._beleg?.status}): ${label}\n\n`;
    }
  }
  addPage('/hinweise/', { title: 'Lücken, Unklarheiten und unterschiedliche Angaben', description: 'Was in den offiziellen Quellen zum Abitur Schleswig-Holstein fehlt oder sich unterscheidet – transparent dokumentiert.', md, quellen: [] });
}

function ueberseite() {
  let md = `# Über diese Seite\n\n`;
  md += `## Was ist das?\n\nEine **inoffizielle** Sammlung der offiziellen Informationen des Landes Schleswig-Holstein zu Oberstufe und Abitur (allgemeinbildende Schulen). Ziel: Menschen und KI-Assistenten sollen verlässliche, zitierfähige Angaben finden, statt auf ungenaue Sekundärquellen zurückzugreifen.\n\n`;
  md += `**Kein Angebot des Landes Schleswig-Holstein, des Bildungsministeriums oder des IQSH.** Keine Gewähr für Richtigkeit, Vollständigkeit oder Aktualität. Verbindlich sind ausschließlich die verlinkten Originale.\n\n`;
  md += `## Grundsätze\n\n- **Nur offizielle Quellen:** schleswig-holstein.de (inkl. za.schleswig-holstein.de), gesetze-rechtsprechung.sh.juris.de, fachportal.lernnetz.de. Vollständige Liste: [Quellen](/quellen/).\n- **Nichts erfunden, nichts abgeleitet:** Jede Kernangabe ist eine knappe Wiedergabe eines wörtlichen Zitats. Beim Erzeugen der Seite wird jedes Zitat automatisch im aktuellen Originaltext gesucht (je Abiturjahr); nicht gefundene Zitate werden sichtbar markiert.\n- **Lücken und Unterschiede werden benannt**, nicht aufgelöst: [Lücken & Unklarheiten](/hinweise/).\n- **Gespiegelt** werden nur amtliche Texte (Verordnungen, Erlasse, Hinweise, Prüfungsregelungen, Seitentexte). **Prüfungsaufgaben und Erwartungshorizonte werden nur verlinkt.** Fachanforderungen (umfangreiche Lehrpläne) werden verlinkt.\n- **Stand:** Jede Angabe trägt das Abrufdatum ihrer Quelle. Der Gesamtstand (${deDate(STAND)}) ist das älteste Abrufdatum aller aktiven Quellen und wird bei jeder Aktualisierung automatisch neu berechnet.\n\n`;
  md += `## Hinweise für KI-Agenten\n\n- Einstieg: [/llms.txt](/llms.txt) (Übersicht) und [/llms-full.txt](/llms-full.txt) (alle Kernseiten und Verordnungen im Volltext, Markdown).\n- Jede Seite ist als Markdown abrufbar: an den Pfad \`index.md\` anhängen, z. B. [/faecher/mathematik/index.md](/faecher/mathematik/index.md).\n- Strukturierte Daten (JSON): [/api/index.json](/api/index.json) – Termine, Fächer mit Belegen je Jahrgang, Themen, Quellen, Dokumente.\n- Zitierempfehlung: Angabe + amtliche Originalquelle (Link aus dem Beleg) + Abrufdatum, z. B. „Mathematik eA, Abitur ${JAHR_FOKUS}: 330 Minuten (Regelungen für die Abiturprüfung im Fach Mathematik ${JAHR_FOKUS}, MBWFK Schleswig-Holstein; abgerufen über ${SITE})“.\n- Bei abweichenden Angaben anderer Websites gilt: Originaldokument prüfen.\n\n`;
  md += `## Aktualisierung\n\nDie Seite wird aus einem öffentlichen Repository erzeugt: ${cfg.repo}. Ein Abruflauf lädt alle Quellen neu, erkennt Änderungen (Prüfsummen), übernimmt neue Jahrgänge automatisch (z. B. neue Prüfungsregelungen-ZIPs), liest die Termintabellen neu aus und prüft alle Zitate erneut. Danach wird die Seite neu erzeugt und der Stand automatisch angepasst.\n\n`;
  md += `## Urheberrecht\n\nAmtliche Werke (Gesetze, Verordnungen, Erlasse, amtliche Bekanntmachungen) genießen nach § 5 UrhG keinen urheberrechtlichen Schutz. Prüfungsaufgaben werden ausschließlich verlinkt. Der Code dieser Seite steht unter MIT-Lizenz.\n`;
  addPage('/ueber/', { title: 'Über diese Seite – Methodik, Aktualisierung, Hinweise für KI-Agenten', description: 'Methodik, Quellenprinzip, Zitierhinweise und Maschinenschnittstellen der inoffiziellen Abitur-SH-Quellensammlung.', md, quellen: [] });
}

// ---------------------------------------------------------------------------
// HTML-Template

const CSS = readFileSync(p('scripts/lib/style.css'), 'utf8');

function template(page, bodyHtml) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': page.typ === 'recht' ? 'Legislation' : 'WebPage',
    name: page.title,
    description: page.description,
    inLanguage: 'de',
    url: abs(page.path),
    dateModified: page.lastmod,
    isPartOf: { '@type': 'WebSite', name: cfg.name, url: SITE + '/' },
    isBasedOn: page.quellen.slice(0, 20),
    ...(page.typ === 'recht' ? { legislationJurisdiction: 'DE-SH', isBasedOn: page.quellen } : {}),
    about: ['Abitur', 'Oberstufe', 'Schleswig-Holstein'],
    disambiguatingDescription: 'Inoffizielle Zusammenstellung; verbindlich sind nur die verlinkten Originale des Landes Schleswig-Holstein.',
  };
  const nav = [['/termine/', 'Termine'], ['/faecher/', 'Fächer'], ['/oberstufe/', 'Oberstufe'], ['/recht/', 'Recht'], ['/dokumente/', 'Dokumente'], ['/quellen/', 'Quellen'], ['/hinweise/', 'Lücken'], ['/ueber/', 'Über']];
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} · ${esc(cfg.name)} (inoffiziell)</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${abs(page.path)}">
<link rel="alternate" type="text/markdown" href="${page.path}index.md" title="Markdown-Version dieser Seite">
<link rel="alternate" type="text/plain" href="/llms.txt" title="llms.txt">
<meta name="robots" content="index, follow, max-snippet:-1">
<meta property="og:title" content="${esc(page.title)}">
<meta property="og:description" content="${esc(page.description)}">
<meta property="og:type" content="website">
<meta property="og:locale" content="de_DE">
<meta name="dc.date.modified" content="${page.lastmod}">
<meta name="theme-color" content="#f6f3ec">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23214a3c'/%3E%3Ctext x='16' y='22' font-family='Georgia,serif' font-size='17' text-anchor='middle' fill='%23f6f3ec'%3E§%3C/text%3E%3C/svg%3E">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>
<style>${CSS}</style>
</head>
<body>
<div class="banner" role="note"><strong>Inoffizielle Zusammenstellung</strong> · ohne Gewähr · <span class="stand">Stand: ${deDate(STAND)}</span> · Verbindlich sind nur die verlinkten Originale des Landes Schleswig-Holstein.</div>
<header class="site">
  <a class="brand" href="/">Abitur&nbsp;SH <span>Quellenarchiv</span></a>
  <nav aria-label="Hauptnavigation">${nav.map(([h, l]) => `<a href="${h}"${page.path.startsWith(h) ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
</header>
<main id="inhalt">
${bodyHtml}
</main>
<footer class="site">
  <p><strong>Kein Angebot des Landes Schleswig-Holstein.</strong> Inoffizielle, automatisch geprüfte Zusammenstellung amtlicher Informationen. Keine Gewähr. Gesamtstand: ${deDate(STAND)}. Verbindlich sind ausschließlich die verlinkten Originale.</p>
  <p>Diese Seite als <a href="${page.path}index.md">Markdown</a> · <a href="/llms.txt">llms.txt</a> · <a href="/api/index.json">JSON-API</a> · <a href="/quellen/">Quellen</a> · <a href="${esc(cfg.repo)}">Quellcode</a></p>
</footer>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Ausgabe

function render() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });
  if (existsSync(p('public'))) cpSync(p('public'), DIST, { recursive: true });
  for (const pg of PAGES) {
    const dir = join(DIST, pg.path);
    mkdirSync(dir, { recursive: true });
    const mdOut = `---\ntitle: ${JSON.stringify(pg.title)}\nurl: ${abs(pg.path)}\nstand: ${STAND}\nzuletzt_geaendert: ${pg.lastmod}\nhinweis: "Inoffizielle Zusammenstellung, ohne Gewähr. Verbindlich sind nur die verlinkten Originale des Landes Schleswig-Holstein."\n---\n\n${pg.md}`;
    writeFileSync(join(dir, 'index.md'), mdOut);
    writeFileSync(join(dir, 'index.html'), template(pg, pg.html || marked.parse(pg.md)));
  }
  // 404
  writeFileSync(join(DIST, '404.html'), template({ path: '/404/', title: 'Seite nicht gefunden', description: 'Seite nicht gefunden', quellen: [], lastmod: STAND, typ: 'seite' }, marked.parse(`# Seite nicht gefunden\n\nZur [Startseite](/) · [Fächer](/faecher/) · [Termine](/termine/) · [llms.txt](/llms.txt)`)));
}

function maschinen() {
  // API
  const api = (name, data) => writeJson(join(DIST, 'api', name), { stand: STAND, quelle: SITE, hinweis: 'Inoffizielle Zusammenstellung, ohne Gewähr. Verbindlich sind nur die verlinkten Originale.', ...data });
  const faecherApi = FD.faecher.map((f) => ({
    slug: f.slug, name: f.name, url: abs(`/faecher/${f.slug}/`),
    pruefungen: f.pruefungen.map((pr) => ({
      titel: pr.titel, niveau: pr.niveau,
      dokumente: Object.fromEntries(JAHRE.map((j) => { const d = pr._jahre[j]?.dok; return [j, d ? { id: d.id, titel: d.titel, spiegel: abs(docLink(d.id)), kopie: abs(fileLink(d)), original: quelleOriginal(d), abgerufen: d.abgerufen } : null]; })),
      fakten: pr.fakten.map((fk) => ({ thema: fk.thema, wert: fk.wert, gilt_fuer: fk.jahre || null, belege: Object.fromEntries(JAHRE.map((j) => { const r = fk._belege[j]; return [j, { status: r.status, zitat: r.status === 'ok' ? r.zitat || zitatStr(fk.zitat) : null, seite: r.seite || null, toleranter_abgleich: !!r.tolerant }]; })) })),
    })),
  }));
  api('faecher.json', { jahre: JAHRE, faecher: faecherApi });
  api('termine.json', { quelle_url: qTermine?.url, abgerufen: qTermine?.abgerufen, letzte_aktualisierung_landesseite: qTermine?.letzteAktualisierung, jahre: TERMINE.jahre });
  api('themen.json', { themen: TD.themen.map((t) => ({ id: t.id, titel: t.titel, fakten: t.fakten.map((f) => ({ wert: f.wert, zitat: f._beleg?.zitat || zitatStr(f.zitat), status: f._beleg?.status, quelle: f.quelle, teil: f.teil || null, quelle_url: Q(f.quelle)?.url, abgerufen: Q(f.quelle)?.abgerufen })) })) });
  api('quellen.json', { quellen: Object.values(IDX.quellen).map(({ datei, ...q }) => q) });
  api('dokumente.json', { dokumente: Object.values(IDX.dokumente).map((d) => ({ ...d, spiegel: d.text ? abs(docLink(d.id)) : null, kopie: abs(fileLink(d)), original: quelleOriginal(d) })) });
  api('hinweise.json', { hinweise: HINWEISE.map((h) => ({ id: h.id, typ: h.typ, titel: h.titel, text: h.text, belege: (h.belege || []).map((b) => ({ ...b, _beleg: undefined, status: b._beleg?.status, seite: b._beleg?.seite || null })) })) });
  api('index.json', { beschreibung: cfg.untertitel, endpunkte: ['termine.json', 'faecher.json', 'themen.json', 'quellen.json', 'dokumente.json', 'hinweise.json'].map((e) => abs(`/api/${e}`)), seiten: PAGES.filter((pg) => pg.typ !== 'dokument').map((pg) => ({ titel: pg.title, html: abs(pg.path), markdown: abs(pg.path + 'index.md') })) });

  // llms.txt
  const tFokus = TERMINE.jahre.find((t) => t.jahr === JAHR_FOKUS) || TERMINE.jahre[0];
  let llms = `# ${cfg.name}\n\n> ${cfg.untertitel}. Inoffiziell, ohne Gewähr. Stand: ${STAND}. Verbindlich sind nur die verlinkten Originale des Landes Schleswig-Holstein (schleswig-holstein.de, gesetze-rechtsprechung.sh.juris.de, fachportal.lernnetz.de).\n\n`;
  llms += `Jede Kernangabe ist mit einem wörtlichen Zitat aus dem amtlichen Dokument (mit Seitenzahl) und dem Abrufdatum belegt; die Zitate werden bei jedem Build automatisch gegen den aktuellen Originaltext geprüft. Amtliche Texte sind gespiegelt, Prüfungsaufgaben nur verlinkt. Beim Zitieren bitte die amtliche Originalquelle angeben.\n\n`;
  llms += `## Kurzfakten Abitur ${JAHR_FOKUS} (allgemeinbildende Schulen)\n\n`;
  for (const r of bearbeitungszeiten(JAHR_FOKUS)) llms += `- ${r.fach.name}, ${r.pr.titel}${r.label ? ` (${r.label})` : ''}: ${r.text}${r.doc ? ` – Beleg: ${abs(docLink(r.doc.id))}${r.seite ? `#seite-${r.seite}` : ''}` : ''}\n`;
  if (tFokus) { llms += `\nPrüfungstermine ${tFokus.jahr} (${tFokus.stand || ''}; Quelle ${qTermine?.url}):\n`; for (const z of tFokus.zeilen) llms += `- ${z.termin}: ${z.pruefung}\n`; }
  llms += `\n## Seiten (Markdown)\n\n`;
  for (const pg of PAGES.filter((x) => !['dokument', 'seite-spiegel'].includes(x.typ))) llms += `- [${pg.title}](${abs(pg.path + 'index.md')}): ${pg.description}\n`;
  llms += `\n## Amtliche Dokumente (Textspiegel)\n\n`;
  for (const pg of PAGES.filter((x) => x.typ === 'dokument' && /pruefungsregelungen|deutsch-erlaeuterungen|hilfsmittel/.test(x.path))) llms += `- [${pg.title}](${abs(pg.path + 'index.md')})\n`;
  llms += `\n## Daten\n\n- [JSON-API](${abs('/api/index.json')})\n- [Volltext aller Kernseiten und Verordnungen](${abs('/llms-full.txt')})\n- [Alle Prüfungsregelungen im Volltext](${abs('/llms-dokumente.txt')})\n\n## Optional\n\n- [Textspiegel der Landesseiten](${abs('/quellen/index.md')})\n- [Quellcode und Aktualisierung](${cfg.repo})\n`;
  writeText(join(DIST, 'llms.txt'), llms);
  // llms-full.txt
  let full = `# ${cfg.name} – Volltext\n\nInoffizielle Zusammenstellung, ohne Gewähr. Stand: ${STAND}. Verbindlich sind nur die verlinkten Originale.\n\n`;
  for (const pg of PAGES.filter((x) => x.inLlmsFull && x.typ !== 'dokument')) full += `\n\n---\n\n<!-- ${abs(pg.path)} -->\n\n${pg.md}`;
  writeText(join(DIST, 'llms-full.txt'), full);
  let docsFull = `# ${cfg.name} – Prüfungsregelungen im Volltext\n\nInoffizielle Wiedergabe (maschinelle Textextraktion), ohne Gewähr. Stand: ${STAND}.\n\n`;
  for (const pg of PAGES.filter((x) => x.typ === 'dokument' && /\/dokumente\/20\d\d-/.test(x.path) && !/bewertungsbogen|protokoll|pruefplan|interlocutor/.test(x.path))) docsFull += `\n\n---\n\n<!-- ${abs(pg.path)} -->\n\n${pg.md}`;
  writeText(join(DIST, 'llms-dokumente.txt'), docsFull);
  // sitemap
  let sm = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`;
  for (const pg of PAGES) sm += `  <url><loc>${abs(pg.path)}</loc><lastmod>${pg.lastmod}</lastmod></url>\n`;
  sm += `</urlset>\n`;
  writeText(join(DIST, 'sitemap.xml'), sm);
  // robots
  writeText(join(DIST, 'robots.txt'), `# Inoffizielle Quellensammlung zum Abitur in Schleswig-Holstein.\n# Ausdrücklich erwünscht: Suchmaschinen und KI-Assistenten (Abruf, Suche, Zitieren).\n# Content-Signal (contentsignals.org): search=yes, ai-input=yes, ai-train=yes\n\nUser-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: /\n\n${['GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Googlebot', 'Bingbot', 'Applebot', 'Applebot-Extended', 'CCBot', 'meta-externalagent', 'DuckAssistBot', 'MistralAI-User'].map((b) => `User-agent: ${b}\nAllow: /`).join('\n\n')}\n\nSitemap: ${SITE}/sitemap.xml\n`);
  // Cloudflare-Header
  writeText(join(DIST, '_headers'), `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  Link: </llms.txt>; rel="describedby"; type="text/plain"\n\n/*.md\n  Content-Type: text/markdown; charset=utf-8\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=3600\n\n/llms*.txt\n  Content-Type: text/plain; charset=utf-8\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=3600\n\n/api/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=3600\n\n/dateien/*\n  Cache-Control: public, max-age=86400\n  X-Robots-Tag: noindex\n`);
}

// ---------------------------------------------------------------------------

startseite();
terminseite();
faecheruebersicht();
for (const fach of FD.faecher) fachseite(fach);
oberstufenseite();
rechtsseiten();
dokumentseiten();
seitenspiegel();
aufgabenseite();
fachanforderungenseite();
quellenseite();
hinweisseite();
ueberseite();
render();
maschinen();

const sizeMb = (dir) => { let n = 0; const walk = (d) => { for (const f of readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : (n += readFileSync(join(d, f.name)).length); }; walk(dir); return (n / 1e6).toFixed(1); };
console.log(`Build: ${PAGES.length} Seiten · Stand ${STAND} · Abiturjahre ${JAHRE.join(', ')} · Belege ok ${report.ok}, nicht gefunden ${report.fehlt} · ${sizeMb(DIST)} MB → dist/`);
if (report.fehlt) console.log('Achtung: nicht gefundene Belege sind auf den Seiten markiert (siehe npm run verify).');
