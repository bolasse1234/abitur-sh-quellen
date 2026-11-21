#!/usr/bin/env node
// Prüft alle wörtlichen Belege in data/*.yaml gegen die aktuellen Schnappschüsse.
// Exit-Code 1, wenn ein Zitat nicht (mehr) gefunden wird.
import { pruefeAlles, pruefeHinweise } from './lib/belege.mjs';

const { report, index, jahre } = pruefeAlles();
for (const h of pruefeHinweise(index)) for (const b of h.belege || []) if (b._beleg.status !== 'ok') { report.fehlt++; report.details.push(`Hinweis ${h.id}: Beleg ${b.dok || b.quelle} → ${b._beleg.status}`); } else report.ok++;
console.log(`Abiturjahre mit Prüfungsregelungen: ${jahre.join(', ')}`);
console.log(`Belege ok: ${report.ok} · nicht gefunden: ${report.fehlt}`);
for (const d of report.details) console.log('  ✗ ' + d);
const probleme = index.probleme || [];
if (probleme.length) {
  console.log(`\nProbleme beim letzten Abruf (${index.letzterLauf}):`);
  for (const pr of probleme) console.log('  ! ' + pr);
}
process.exitCode = report.fehlt ? 1 : 0;
