#!/bin/bash
#
# build.sh — kompiliert WorkTracker zu einem .app-Bundle (ohne Xcode-Projekt).
#
set -euo pipefail
cd "$(dirname "$0")"

APP="WorkTracker.app"
CONTENTS="$APP/Contents"
BIN_DIR="$CONTENTS/MacOS"
RES_DIR="$CONTENTS/Resources"

rm -rf "$APP"
mkdir -p "$BIN_DIR" "$RES_DIR"
cp Info.plist "$CONTENTS/Info.plist"

# App-Icon aus AppIcon.png (idealerweise 1024x1024) erzeugen, falls vorhanden.
if [ -f AppIcon.png ]; then
  echo "Generating app icon…"
  ICONSET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for sz in 16 32 128 256 512; do
    sips -z "$sz" "$sz"           AppIcon.png --out "$ICONSET/icon_${sz}x${sz}.png"    >/dev/null 2>&1
    sips -z "$((sz*2))" "$((sz*2))" AppIcon.png --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "$RES_DIR/AppIcon.icns" && echo "✓ Icon eingebettet"
fi

SDK="$(xcrun --show-sdk-path --sdk macosx)"
ARCH="$(uname -m)"   # arm64 oder x86_64

echo "Compiling ($ARCH)…"
swiftc \
  -swift-version 5 \
  -sdk "$SDK" \
  -target "${ARCH}-apple-macosx14.0" \
  -O \
  Sources/*.swift \
  -o "$BIN_DIR/WorkTracker"

# Ad-hoc-Signatur (lokal ausreichend, noetig u. a. fuer Login-Item & Notifications).
codesign --force --sign - "$APP" >/dev/null 2>&1 || true

echo "✓ Built $APP"
echo "  Start:  open $APP   (oder: ./$BIN_DIR/WorkTracker)"
