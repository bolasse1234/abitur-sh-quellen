# Abitur SH – Quellenarchiv

**Live:** https://abitur-sh-quellen.bolasse-borchardt.workers.dev

Eine inoffizielle, quellenbelegte Zusammenstellung der amtlichen Informationen des Landes
Schleswig-Holstein zu Oberstufe und Abitur (allgemeinbildende Schulen): Prüfungstermine,
Bearbeitungszeiten, Aufbau und Auswahl der Prüfungen je Fach und Niveau, Hilfsmittel, dazu die
Verordnungen (OAPVO, APVO-EW, AGVO, BGVO) im Volltext. Gebaut für Menschen **und vor allem für
KI-Agenten**: statisches HTML, jede Seite zusätzlich als Markdown, `llms.txt`, JSON-API und Sitemap.

> Kein Angebot des Landes Schleswig-Holstein. Ohne Gewähr. Verbindlich sind nur die verlinkten Originale.

## Grundsätze

- **Nur offizielle Quellen** (`sources/sources.yaml`): schleswig-holstein.de (za.schleswig-holstein.de leitet dorthin),
  gesetze-rechtsprechung.sh.juris.de, fachportal.lernnetz.de.
- **Nichts erfinden:** Jede Kernangabe in `data/*.yaml` ist eine knappe Wiedergabe eines **wörtlichen Zitats**.
  Der Build sucht jedes Zitat im aktuellen Originaltext (je Abiturjahr, mit Seitenzahl). Nicht gefundene
  Zitate werden auf der Seite sichtbar markiert und von `npm run verify` gemeldet.
- **Lücken und Unterschiede** werden benannt (Seite `/hinweise/`, Datei `data/hinweise.yaml`), nicht aufgelöst.
- **Spiegeln vs. verlinken:** Amtliche Texte (Verordnungen, Erlasse, Hinweise, Prüfungsregelungen, Seitentexte)
  werden gespiegelt. **Prüfungsaufgaben und Erwartungshorizonte werden nur verlinkt.** Die Fachanforderungen
  (umfangreiche Lehrpläne) werden verlinkt.
- **Stand automatisch:** Jede Quelle hat ein Abrufdatum. Der Gesamtstand ist das älteste Abrufdatum aller
  aktiven Quellen und wird bei jedem Abruf neu berechnet.

## Aufbau

```
sources/sources.yaml     Quellenregister inkl. Entdeckungsregeln (neue Jahrgänge werden automatisch gefunden)
scripts/fetch.mjs        Abruf aller Quellen → snapshots/ (Texte, Metadaten) + public/dateien/ (Originaldateien)
scripts/lib/juris.mjs    Abruf der Verordnungen aus dem juris-Portal (Headless-Chromium via playwright-core)
scripts/verify.mjs       Prüft alle Zitate gegen die Schnappschüsse
scripts/build.mjs        Erzeugt dist/ (HTML + index.md je Seite, llms.txt, llms-full.txt, api/*.json, sitemap, robots)
data/faecher.yaml        Kernangaben je Fach/Niveau mit Zitaten
data/themen.yaml         Übergreifende Regeln (OAPVO, Landesseiten) mit Zitaten
data/hinweise.yaml       Redaktionelle Hinweise zu Lücken/Unterschieden mit Belegen
snapshots/index.json     Abrufdaten, Prüfsummen, Status aller Quellen und Dokumente
```

## Voraussetzungen

Node.js ≥ 20, `pdftotext`/`pdfinfo` (Paket *poppler-utils*), `unzip`, und für die Verordnungen ein
Chromium (wird automatisch unter `~/.cache/ms-playwright` gesucht; sonst `CHROME_PATH=/pfad/zu/chrome`
setzen oder `npx playwright-core install chromium`).

```bash
npm install
```

## Aktualisieren (manuell, ein Befehl)

```bash
npm run update      # = fetch + build: alle Quellen neu abrufen, Zitate prüfen, Seite bauen
npm run verify      # Prüfbericht: alle Zitate gefunden?
npm run deploy      # bauen + auf Cloudflare veröffentlichen (wrangler login nötig)
```

Optionen: `npm run fetch -- --nur za-termine,oapvo` (nur einzelne Quellen), `--ohne-juris` (ohne Browser).
Optional kann eine Firecrawl-Instanz als Ausweichweg für Webseiten genutzt werden:
`FIRECRAWL_URL=http://127.0.0.1:<port> npm run fetch` (Firecrawl-v2-API).

**Wenn `verify` ein Zitat nicht mehr findet**, hat sich das Originaldokument geändert:
1. Seite/Dokument unter `snapshots/` bzw. auf der Website (`/dokumente/<id>/`) ansehen.
2. In `data/faecher.yaml` (oder `themen.yaml`/`hinweise.yaml`) das Zitat aktualisieren – als Liste mit
   Alternativen, wenn ältere Jahrgänge den alten Wortlaut behalten – oder die Angabe mit `jahre: [...]`
   auf bestimmte Jahrgänge beschränken.
3. `npm run verify && npm run deploy`.

Neue Abiturjahrgänge (z. B. „Prüfungsregelungen 2030“) werden automatisch erkannt, gespiegelt und in
Übersichten aufgenommen. Für die Kernangaben eines neuen Jahrgangs prüft `verify` die bestehenden Zitate
automatisch gegen die neuen Dokumente; nur abweichende Stellen brauchen Pflege. Weicht der Dateiname eines
Dokuments ab, in `data/faecher.yaml` unter `dok:` den Schlüssel für das Jahr ergänzen (die IDs stehen in
`snapshots/index.json` → `dokumente`).

## Automatische Aktualisierung (GitHub Actions)

- `.github/workflows/update.yml` läuft **wöchentlich** (montags) und auf Knopfdruck: Abruf → Prüfung → Build.
  Sind alle Belege bestätigt, wird direkt committet und deployt; sonst wird ein **Pull Request mit Prüfbericht** geöffnet.
- `.github/workflows/deploy.yml` deployt bei jedem Push auf `main`.

Dafür im Repo unter *Settings → Secrets and variables → Actions* anlegen:

| Secret | Wert |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API-Token mit Recht „Workers Scripts: Edit“ (dash.cloudflare.com → My Profile → API Tokens → Vorlage „Edit Cloudflare Workers“) |
| `CLOUDFLARE_ACCOUNT_ID` | Account-ID (Cloudflare-Dashboard, rechte Seitenleiste) |

Ohne Token laufen Abruf und Build trotzdem; nur das Deployment wird übersprungen.

## Deployment von Hand

```bash
npx wrangler login     # einmalig
npm run deploy
```

Die Seite ist ein reiner Static-Assets-Worker (`wrangler.jsonc`). Eigene Domain: im Cloudflare-Dashboard unter
*Workers & Pages → abitur-sh-quellen → Settings → Domains & Routes*; danach `url` in `site.config.json` anpassen.

## Für KI-Agenten

- `/llms.txt` – Übersicht mit Kurzfakten; `/llms-full.txt` – Kernseiten + Verordnungen; `/llms-dokumente.txt` – Prüfungsregelungen
- `<pfad>/index.md` – Markdown-Version jeder Seite
- `/api/index.json` – Termine, Fächer (mit Belegen je Jahrgang), Themen, Quellen, Dokumente, Hinweise
- `robots.txt` erlaubt alle Such- und KI-Crawler ausdrücklich.

## Lizenz

Code: MIT (siehe `LICENSE`). Gespiegelte Inhalte sind amtliche Werke des Landes Schleswig-Holstein
(§ 5 UrhG); Prüfungsaufgaben werden nicht gespiegelt.
