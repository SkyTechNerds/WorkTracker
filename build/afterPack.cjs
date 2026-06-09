// Ad-hoc-Signing für macOS (gratis): signiert die .app mit "-", damit sie auf
// Apple Silicon startet und nicht als "beschädigt" abgewiesen wird. Keine
// Notarisierung -> Gatekeeper warnt beim ersten Download einmalig (intern ok).
const { execSync } = require('node:child_process')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`
  try {
    // KEIN --options runtime (Hardened Runtime) -> sonst Library-Validation, und das
    // ad-hoc-signierte Electron-Framework wird beim Laden abgelehnt ("different Team IDs").
    execSync(`codesign --deep --force --sign - "${app}"`, { stdio: 'inherit' })
    console.log('  • ad-hoc signed', app)
  } catch (e) {
    console.warn('  • ad-hoc signing failed (non-fatal):', e.message)
  }
}
