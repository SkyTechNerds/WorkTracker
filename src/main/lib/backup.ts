// Backup/Restore: bündelt config.json + alle Events (events/*.jsonl) + alle
// Tagesbearbeitungen (daily/*) in eine einzelne JSON-Datei. Für Umzug auf einen
// neuen Rechner oder als Sicherung; optional automatisch in einen Zielordner.

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

function userDir() { return app.getPath('userData') }

export interface Bundle {
  app: 'worktracker'
  version: number
  exportedAt: number
  config: unknown
  events: Record<string, string>
  daily: Record<string, string>
}

export function buildBundle(): Bundle {
  const base = userDir()
  const b: Bundle = { app: 'worktracker', version: 1, exportedAt: Date.now(), config: null, events: {}, daily: {} }
  try { b.config = JSON.parse(fs.readFileSync(path.join(base, 'config.json'), 'utf8')) } catch { /* */ }
  const evDir = path.join(base, 'events')
  try { for (const f of fs.readdirSync(evDir)) if (f.endsWith('.jsonl')) b.events[f] = fs.readFileSync(path.join(evDir, f), 'utf8') } catch { /* */ }
  const dDir = path.join(base, 'daily')
  try { for (const f of fs.readdirSync(dDir)) b.daily[f] = fs.readFileSync(path.join(dDir, f), 'utf8') } catch { /* */ }
  return b
}

export function restoreBundle(b: Bundle): { ok: boolean; error?: string } {
  if (!b || b.app !== 'worktracker') return { ok: false, error: 'Keine gültige WorkTracker-Sicherung' }
  const base = userDir()
  try {
    if (b.config) fs.writeFileSync(path.join(base, 'config.json'), JSON.stringify(b.config, null, 2))
    const evDir = path.join(base, 'events'); fs.mkdirSync(evDir, { recursive: true })
    for (const [f, content] of Object.entries(b.events || {})) if (/^[\w-]+\.jsonl$/.test(f)) fs.writeFileSync(path.join(evDir, f), content)
    const dDir = path.join(base, 'daily'); fs.mkdirSync(dDir, { recursive: true })
    for (const [f, content] of Object.entries(b.daily || {})) if (/^[\w.-]+$/.test(f)) fs.writeFileSync(path.join(dDir, f), content)
    return { ok: true }
  } catch (e: any) { return { ok: false, error: String(e?.message || e) } }
}

export function exportToFile(filePath: string) {
  fs.writeFileSync(filePath, JSON.stringify(buildBundle(), null, 2))
}

export function readBundleFile(filePath: string): Bundle {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`
}

/** Automatisches Backup in den Zielordner, hält die letzten `keep` Dateien. */
export function autoBackupTo(folder: string, keep: number): { ok: boolean; file?: string; error?: string } {
  if (!folder) return { ok: false, error: 'Kein Zielordner' }
  try {
    fs.mkdirSync(folder, { recursive: true })
    const file = path.join(folder, `worktracker-backup-${stamp()}.json`)
    fs.writeFileSync(file, JSON.stringify(buildBundle()))
    const files = fs.readdirSync(folder).filter(f => /^worktracker-backup-.*\.json$/.test(f)).sort()
    while (files.length > Math.max(1, keep)) { const old = files.shift()!; try { fs.rmSync(path.join(folder, old)) } catch { /* */ } }
    return { ok: true, file }
  } catch (e: any) { return { ok: false, error: String(e?.message || e) } }
}
