#!/bin/bash
#
# release.sh — Version hochziehen, bauen, taggen und GitHub-Release mit Changelog
# erstellen.
#
# Nutzung:
#   ./release.sh                # Patch-Release (x.y.Z+1)
#   ./release.sh minor          # x.Y+1.0
#   ./release.sh major          # X+1.0.0
#   ./release.sh 1.2.0          # exakte Version
#   ./release.sh minor --beta   # Vorab-Release (Prerelease, nur Beta-Tester)
#
set -euo pipefail
cd "$(dirname "$0")"

PB=/usr/libexec/PlistBuddy
REPO="SkyTechNerds/WorkTracker"
PRERELEASE=false
ARG=""
for a in "$@"; do
  case "$a" in
    --beta|--prerelease) PRERELEASE=true ;;
    *) ARG="$a" ;;
  esac
done

CUR=$($PB -c "Print CFBundleShortVersionString" Info.plist)
IFS=. read -r MA MI PA <<< "$CUR"
if [[ "$ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW="$ARG"
else
  case "${ARG:-patch}" in
    major) MA=$((MA+1)); MI=0; PA=0 ;;
    minor) MI=$((MI+1)); PA=0 ;;
    patch|"") PA=$((PA+1)) ;;
    *) echo "Unbekanntes Argument: $ARG (patch|minor|major oder x.y.z)"; exit 1 ;;
  esac
  NEW="$MA.$MI.$PA"
fi

BUILD=$($PB -c "Print CFBundleVersion" Info.plist 2>/dev/null || echo 1)
NEWBUILD=$((BUILD+1))
if $PRERELEASE; then TAG="v$NEW-beta.$NEWBUILD"; TITLE="WorkTracker $NEW (Beta)"
else TAG="v$NEW"; TITLE="WorkTracker $NEW"; fi

echo "→ $CUR ⇒ $NEW   (Tag $TAG, Build $NEWBUILD, prerelease=$PRERELEASE)"
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || true)

# Version setzen + bauen
$PB -c "Set CFBundleShortVersionString $NEW" Info.plist
$PB -c "Set CFBundleVersion $NEWBUILD" Info.plist
./package.sh >/dev/null
echo "✓ gebaut & paketiert"

# Changelog (Commits seit letztem Tag)
if [ -n "${LAST_TAG:-}" ]; then
  CHANGES=$(git log "$LAST_TAG"..HEAD --no-merges --pretty='- %s')
else
  CHANGES=$(git log --no-merges --pretty='- %s')
fi
[ -z "$CHANGES" ] && CHANGES="- (keine neuen Commits)"

NOTES=$(mktemp)
{
  echo "### Änderungen seit ${LAST_TAG:-Beginn}"
  echo "$CHANGES"
  echo
  echo "### Installation"
  echo 'ZIP entpacken → nach „Programme" → Rechtsklick „Öffnen". Apple Silicon, macOS 14+.'
} > "$NOTES"

# Commit, Tag, Push
git add Info.plist
git commit -q -m "Release $TAG" || true
git tag -f "$TAG"
git push -q origin HEAD
git push -f origin "$TAG"

# GitHub-Release
PREFLAG=""; $PRERELEASE && PREFLAG="--prerelease"
gh release create "$TAG" "$HOME/Downloads/WorkTracker.zip" --repo "$REPO" \
  --title "$TITLE" --notes-file "$NOTES" $PREFLAG
rm -f "$NOTES"
echo "✓ Release $TAG: https://github.com/$REPO/releases/tag/$TAG"
