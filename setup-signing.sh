#!/bin/bash
#
# setup-signing.sh — erstellt EINMALIG eine selbstsignierte Code-Signing-
# Identität "WorkTracker". Dann behält die App ihre macOS-Berechtigungen
# (Kalender, Mitteilungen) über Rebuilds/Updates hinweg, statt bei jeder
# neuen Version erneut zu fragen.
#
# Hinweis: Beim ersten Signieren fragt der Schlüsselbund evtl. einmalig nach
# Erlaubnis — dort "Immer erlauben" wählen.
#
set -e
NAME="WorkTracker"

if security find-identity -v -p codesigning 2>/dev/null | grep -q "\"$NAME\""; then
  echo "✓ Identität '$NAME' existiert bereits."
  exit 0
fi

DIR="$(mktemp -d)"
cat > "$DIR/cfg" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $NAME
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -keyout "$DIR/key.pem" -out "$DIR/cert.pem" \
  -days 3650 -nodes -config "$DIR/cfg" >/dev/null 2>&1
openssl pkcs12 -export -inkey "$DIR/key.pem" -in "$DIR/cert.pem" \
  -out "$DIR/id.p12" -name "$NAME" -passout pass:wt >/dev/null 2>&1

security import "$DIR/id.p12" -k ~/Library/Keychains/login.keychain-db -P wt -T /usr/bin/codesign
rm -rf "$DIR"

echo "✓ Identität '$NAME' erstellt. Nächster ./build.sh signiert damit stabil."
echo "  (Beim ersten Signieren ggf. im Schlüsselbund 'Immer erlauben' wählen.)"
