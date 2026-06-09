#!/usr/bin/env bash
# release.sh [patch|minor|major|x.y.z]
# Bumpt die Version, baut Mac-DMG + Windows-NSIS, taggt und legt den GitHub-Release an.
set -e
cd "$(dirname "$0")"

BUMP="${1:-patch}"
NEW=$(npm version "$BUMP" --no-git-tag-version | tail -1)   # z. B. v0.2.1
VER="${NEW#v}"
echo "→ Release $NEW"

npm run package:all

git add package.json
git commit --no-verify -m "Release $NEW"
git tag "$NEW"
git push origin main
git push origin "$NEW"

DMG="dist/WorkTracker-${VER}-arm64.dmg"
EXE="dist/WorkTracker Setup ${VER}.exe"

gh release create "$NEW" --repo SkyTechNerds/WorkTracker \
  --title "WorkTracker $VER" \
  --notes "Automatischer Release $NEW. Installation siehe README. Builds sind unsigniert (intern): macOS erst über „Datenschutz & Sicherheit → Trotzdem öffnen“ bzw. \`xattr -dr com.apple.quarantine\`, Windows über SmartScreen → „Trotzdem ausführen“." \
  "$DMG" "$EXE"

echo "✓ https://github.com/SkyTechNerds/WorkTracker/releases/tag/$NEW"
