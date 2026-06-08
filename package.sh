#!/bin/bash
#
# package.sh — baut WorkTracker.app und packt sie als ZIP zum Weitergeben.
#
set -euo pipefail
cd "$(dirname "$0")"

./build.sh

OUT="$HOME/Downloads/WorkTracker.zip"
rm -f "$OUT"
# ditto erhaelt die Bundle-Struktur & Ressourcen korrekt (besser als zip).
ditto -c -k --keepParent WorkTracker.app "$OUT"

echo ""
echo "✓ Paket: $OUT"
echo ""
echo "Weitergabe an Kollegen:"
echo "  1. ZIP schicken, entpacken, WorkTracker.app nach /Programme ziehen."
echo "  2. Erststart: Rechtsklick auf die App → 'Öffnen' → 'Öffnen' bestätigen"
echo "     (oder System­einstellungen → Datenschutz & Sicherheit → 'Dennoch öffnen')."
echo "     Grund: ad-hoc-signiert, nicht über den App Store / nicht notarisiert."
echo "  3. Beim ersten Start Mitteilungs-Berechtigung erlauben."
echo "  4. Eigene Projekte unter Einstellungen → Projekte anlegen."
