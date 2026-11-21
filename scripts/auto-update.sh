#!/usr/bin/env bash
# Automatische Aktualisierung (für einen Rechner mit Internetzugang aus Deutschland, z. B. Raspberry Pi):
#   Quellen abrufen → Zitate prüfen → Seite bauen → committen/pushen → deployen.
# Hintergrund: schleswig-holstein.de und das juris-Portal sind von GitHub-Actions-Servern aus nicht erreichbar.
#
# Voraussetzungen: node ≥ 20, git (Push-Rechte, z. B. via `gh auth login`), poppler-utils, unzip, chromium.
# Optional: CLOUDFLARE_API_TOKEN (+ CLOUDFLARE_ACCOUNT_ID) in ~/.config/abitur-sh.env für das Deployment;
# ohne Token übernimmt der GitHub-Workflow „Deploy“ (falls dort das Secret gesetzt ist).
set -uo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/.config/abitur-sh.env" ] && set -a && . "$HOME/.config/abitur-sh.env" && set +a
if [ -z "${CHROME_PATH:-}" ]; then
  for c in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome; do [ -x "$c" ] && export CHROME_PATH="$c" && break; done
fi
ts() { date '+%Y-%m-%d %H:%M:%S'; }
echo "[$(ts)] Aktualisierung startet"

git pull --ff-only --quiet || { echo "git pull fehlgeschlagen"; exit 1; }
[ -d node_modules ] || npm ci --silent || exit 1

node scripts/fetch.mjs; FETCH=$?
if [ "$FETCH" -eq 3 ]; then echo "[$(ts)] Abruf weitgehend gescheitert – nichts veröffentlicht."; git checkout -- snapshots public 2>/dev/null; exit 1; fi
node scripts/verify.mjs; VERIFY=$?
node scripts/build.mjs || exit 1

git add -A snapshots public data
if git diff --cached --quiet; then echo "[$(ts)] Keine Änderungen."; exit 0; fi
DATE=$(date +%Y-%m-%d)
if [ "$VERIFY" -eq 0 ]; then
  git commit -q -m "Quellen aktualisiert ($DATE)"
  git push -q || exit 1
  if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] || npx wrangler whoami >/dev/null 2>&1; then npx wrangler deploy; fi
  echo "[$(ts)] Veröffentlicht."
else
  BR="update/$DATE"
  git checkout -q -b "$BR" && git commit -q -m "Quellen aktualisiert ($DATE) – Belege prüfen" && git push -q -u origin "$BR"
  command -v gh >/dev/null && gh pr create --title "Quellen aktualisiert – Belege prüfen ($DATE)" --body "Mindestens ein Zitat wurde im aktuellen Originaltext nicht mehr gefunden. Bericht: \`npm run verify\`. Bitte data/*.yaml anpassen und mergen." --head "$BR" --base main
  git checkout -q main
  echo "[$(ts)] Belege unvollständig – Pull Request statt Veröffentlichung."
fi
