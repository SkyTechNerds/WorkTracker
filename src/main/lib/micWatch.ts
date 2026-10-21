// Call-Erkennung über das Mikrofon, pro App (nur macOS).
//
// Fragt alle paar Sekunden den Helfer `mic-users` (native/mic-users.swift) ab, der über die
// CoreAudio-Prozessobjekte (macOS 14+) meldet, WELCHE Prozesse gerade den Audio-Eingang
// benutzen. Ein Call liegt vor, wenn eine App aus der Call-Liste dabei ist.
//
// Warum pro App und nicht pauschal „Mikrofon an": Andere Programme halten den Eingang
// dauerhaft offen (am 21.10.2026 z. B. Adobe Premiere Pro). Das pauschale Signal der
// HA-Companion-App stand deshalb stundenlang auf „an" und ein Call endete nie.
//
// Ergänzt die Teams-API (teams.ts), ersetzt sie nicht: Die Teams-API ist oft
// abgeschaltet, und Zoom/Webex/Browser-Meetings sieht sie gar nicht.

import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DEFAULT_MIC_CALL_APPS } from './micDefaults'

const POLL_MS = 5_000
const ON_AFTER_MS = 5_000   // so lange muss eine Call-App das Mikrofon halten
const OFF_AFTER_MS = 20_000 // so lange ohne, bis der Call als beendet gilt

type MicUser = { pid: number; bundleId: string }

function helperPath(): string {
  // Im Paket unter Contents/Resources (extraResources), in der Entwicklung im Repo.
  return app.isPackaged
    ? path.join(process.resourcesPath, 'mic-users')
    : path.join(app.getAppPath(), 'resources', 'mic-users')
}

export class MicWatch extends EventEmitter {
  inCall = false
  /** Bundle-ID der App, die den Call ausgelöst hat (für Anzeige/Log). */
  app: string | null = null
  status = 'inaktiv'
  private timer?: NodeJS.Timeout
  private callApps: string[] = DEFAULT_MIC_CALL_APPS
  private seenSince: number | null = null
  private goneSince: number | null = null
  private polling = false

  start(callApps?: string[]) {
    if (process.platform !== 'darwin') { this.status = 'nur macOS'; return }
    if (callApps?.length) this.callApps = callApps
    if (this.timer) return
    if (!fs.existsSync(helperPath())) { this.status = 'Helfer fehlt'; return }
    this.status = 'aktiv'
    this.timer = setInterval(() => this.poll(), POLL_MS)
    this.poll()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.seenSince = this.goneSince = null
    this.setCall(false, null)
    this.status = 'inaktiv'
  }

  private poll() {
    if (this.polling) return
    this.polling = true
    execFile(helperPath(), { timeout: 3_000 }, (err, stdout) => {
      this.polling = false
      if (err) { this.status = 'Fehler beim Abfragen'; return }
      let users: MicUser[] = []
      try { users = JSON.parse(stdout) } catch { return }
      const hit = users.find(u => this.callApps.some(p => u.bundleId.startsWith(p)))
      this.evaluate(hit?.bundleId ?? null, Date.now())
    })
  }

  /** Entprellen: an nach ON_AFTER_MS, aus nach OFF_AFTER_MS. */
  private evaluate(bundleId: string | null, now: number) {
    if (bundleId) {
      this.goneSince = null
      if (this.seenSince === null) this.seenSince = now
      if (!this.inCall && now - this.seenSince >= ON_AFTER_MS) this.setCall(true, bundleId)
    } else {
      this.seenSince = null
      if (this.inCall) {
        if (this.goneSince === null) this.goneSince = now
        if (now - this.goneSince >= OFF_AFTER_MS) this.setCall(false, null)
      }
    }
  }

  private setCall(v: boolean, bundleId: string | null) {
    if (v === this.inCall) return
    this.inCall = v
    this.app = bundleId
    this.emit('change', v, bundleId)
  }
}
