// Baut den macOS-Helfer resources/mic-users aus native/mic-users.swift.
// Auf anderen Plattformen nichts zu tun (Mikrofon-Erkennung gibt es nur auf macOS).
const { execSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

if (process.platform !== 'darwin') process.exit(0)
const root = path.join(__dirname, '..')
fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
execSync('swiftc -O -target arm64-apple-macos14.0 native/mic-users.swift -o resources/mic-users',
  { cwd: root, stdio: 'inherit' })
console.log('  • native helper built: resources/mic-users')
