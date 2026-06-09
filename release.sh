#!/usr/bin/env bash
# release.sh [patch|minor|major|x.y.z]
# Bumpt die Version, baut Mac-DMG + Windows-NSIS, taggt und legt den GitHub-Release
# mit automatisch generiertem Changelog (Commits seit dem letzten Release) an.
set -e
cd "$(dirname "$0")"

BUMP="${1:-patch}"
# Letzten GitHub-Release als Basis (Fallback: letzter Git-Tag)
PREV=$(gh release view --repo SkyTechNerds/WorkTracker --json tagName --jq '.tagName' 2>/dev/null || true)
[ -z "$PREV" ] && PREV=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
NEW=$(npm version "$BUMP" --no-git-tag-version | tail -1)   # z. B. v0.2.3
VER="${NEW#v}"
echo "→ Release $NEW (letzter Release: ${PREV:-keiner})"

# Changelog aus Commit-Nachrichten seit dem letzten Release
NOTES=$(mktemp)
{
  echo "## Änderungen"
  if [ -n "$PREV" ]; then
    git log "$PREV"..HEAD --no-merges --pretty="- %s" | grep -v "^- Release " || echo "- (keine)"
  else
    git log --no-merges --pretty="- %s" | grep -v "^- Release "
  fi
  echo ""
  echo "## Installation"
  echo "- **macOS:** DMG öffnen → in „Programme“ ziehen. Beim 1. Start (unsigniert): Systemeinstellungen → Datenschutz & Sicherheit → „Trotzdem öffnen“ (oder \`xattr -dr com.apple.quarantine /Applications/WorkTracker.app\`)."
  echo "- **Windows:** Setup ausführen, SmartScreen → „Weitere Informationen“ → „Trotzdem ausführen“."
} > "$NOTES"

npm run package:all

git add package.json
git commit --no-verify -m "Release $NEW"
git tag "$NEW"
git push origin main
git push origin "$NEW"

DMG="dist/WorkTracker-${VER}-arm64.dmg"
EXE="dist/WorkTracker Setup ${VER}.exe"
gh release create "$NEW" --repo SkyTechNerds/WorkTracker \
  --title "WorkTracker $VER" --notes-file "$NOTES" \
  "$DMG" "$EXE"
rm -f "$NOTES"

echo "✓ https://github.com/SkyTechNerds/WorkTracker/releases/tag/$NEW"
