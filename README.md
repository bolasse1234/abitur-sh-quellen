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

## Automatische Aktualisierung

**Wichtig:** schleswig-holstein.de und das juris-Portal sind von GitHub-Actions-Servern (US-Rechenzentren)
aus **nicht erreichbar** (getestet 11/2026: Timeouts). Die regelmäßige Aktualisierung muss deshalb von einem
Rechner mit Internetzugang aus Deutschland laufen – vorgesehen ist ein Raspberry Pi (leichter Job, ~3 Minuten/Woche).

Einrichtung auf dem Pi (Raspberry Pi OS / Debian):

```bash
sudo apt install -y nodejs npm git poppler-utils unzip chromium gh   # Node ≥ 20 nötig (ggf. via NodeSource)
gh auth login                                                       # Push-Rechte für das Repo
git clone https://github.com/bolasse1234/abitur-sh-quellen.git ~/abitur-sh-quellen
cd ~/abitur-sh-quellen && npm ci
# optional fürs Deployment direkt vom Pi:
printf 'CLOUDFLARE_API_TOKEN=...\nCLOUDFLARE_ACCOUNT_ID=...\n' > ~/.config/abitur-sh.env && chmod 600 ~/.config/abitur-sh.env
mkdir -p ~/.config/systemd/user && cp ops/systemd/* ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now abitur-sh-update.timer
sudo loginctl enable-linger "$USER"                                  # Timer läuft auch ohne Login
```

`scripts/auto-update.sh` (wöchentlich, montags 05:30) ruft alle Quellen ab, prüft alle Zitate und baut die Seite.
- Alle Belege bestätigt → Commit + Push auf `main` und Deployment (mit Token direkt, sonst über den GitHub-Workflow „Deploy“).
- Ein Zitat fehlt → Branch + **Pull Request** mit Hinweis; die Live-Seite bleibt unverändert, bis du die Daten angepasst hast.
- Abruf weitgehend gescheitert (Netz/Sperre) → nichts wird veröffentlicht.

Manuell geht dasselbe jederzeit mit `scripts/auto-update.sh` oder `npm run update && npm run deploy`.

GitHub Actions:
- `.github/workflows/deploy.yml` prüft, baut und deployt bei jedem Push auf `main` (braucht Secrets, s. u.).
- `.github/workflows/update.yml` ist nur manuell startbar (falls die Landesserver später von dort erreichbar sind).

Secrets im Repo (*Settings → Secrets and variables → Actions*):

| Secret | Wert |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API-Token mit „Workers Scripts: Edit“ (dash.cloudflare.com → My Profile → API Tokens → Vorlage „Edit Cloudflare Workers“) |
| `CLOUDFLARE_ACCOUNT_ID` | bereits gesetzt |

Ohne Token laufen Prüfung und Build trotzdem; nur das Deployment wird übersprungen.

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
