// Persistenz: Config (JSON), Roh-Events (JSONL/Tag), manuelle Overrides (edits.json).
// Cross-platform über Electrons userData-Pfad.

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { AppConfig, WTEvent, Segment, defaultConfig, PROJECT_COLORS } from './types'

/** Eine Palettenfarbe, die noch nicht vergeben ist (sonst zufällig). */
function freeColor(used: string[]): string {
  const free = PROJECT_COLORS.filter(c => !used.includes(c))
  const pool = free.length ? free : PROJECT_COLORS
  return pool[Math.floor(Math.random() * pool.length)]
}

const dataDir = () => {
  const base = app.getPath('userData')
  ensureDir(base)
  ensureDir(path.join(base, 'events'))
  ensureDir(path.join(base, 'daily'))
  return base
}

function ensureDir(p: string) {
  try { fs.mkdirSync(p, { recursive: true }) } catch { /* ignore */ }
}

export function dayKey(d: Date | number): string {
  const date = typeof d === 'number' ? new Date(d) : d
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// ---- Config ----

const configPath = () => path.join(dataDir(), 'config.json')

export function loadConfig(): AppConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    const cfg: AppConfig = { ...defaultConfig(), ...raw } // tolerante Migration
    // Projekte ohne Farbe eindeutige Farben geben (Altdaten-Migration).
    let changed = false
    const used: string[] = []
    cfg.projects = (cfg.projects || []).map(p => {
      if (p.color) { used.push(p.color); return p }
      const color = freeColor(used); used.push(color); changed = true
      return { ...p, color }
    })
    if (changed) saveConfig(cfg)
    return cfg
  } catch {
    const c = defaultConfig()
    saveConfig(c)
    return c
  }
}

export function saveConfig(c: AppConfig) {
  try { fs.writeFileSync(configPath(), JSON.stringify(c, null, 2)) } catch { /* ignore */ }
}

// ---- Events (append-only JSONL pro Tag) ----

const eventsFile = (d: Date | number) => path.join(dataDir(), 'events', `${dayKey(d)}.jsonl`)

export function appendEvent(ev: WTEvent) {
  try { fs.appendFileSync(eventsFile(ev.ts), JSON.stringify(ev) + '\n') } catch { /* ignore */ }
}

export function loadEvents(d: Date | number): WTEvent[] {
  try {
    const content = fs.readFileSync(eventsFile(d), 'utf8')
    const out: WTEvent[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch { /* skip */ }
    }
    return out.sort((a, b) => a.ts - b.ts)
  } catch {
    return []
  }
}

export function earliestDay(): Date | null {
  try {
    const files = fs.readdirSync(path.join(dataDir(), 'events')).filter(f => f.endsWith('.jsonl'))
    const dates = files.map(f => f.replace('.jsonl', '')).sort()
    if (!dates.length) return null
    const [y, m, d] = dates[0].split('-').map(Number)
    return new Date(y, m - 1, d)
  } catch {
    return null
  }
}

// ---- Overrides (materialisierte Segmente) ----

const editsFile = (d: Date | number) => path.join(dataDir(), 'daily', `${dayKey(d)}.edits.json`)

export function isMaterialized(d: Date | number): boolean {
  return fs.existsSync(editsFile(d))
}

export function loadStoredSegments(d: Date | number): Segment[] | null {
  try { return JSON.parse(fs.readFileSync(editsFile(d), 'utf8')) } catch { return null }
}

export function saveSegments(d: Date | number, segs: Segment[]) {
  // Schutz: Segmente ohne positive Dauer (Null/negativ) verwerfen -> keine kaputten Einträge.
  const sorted = segs.filter(s => s.end > s.start).sort((a, b) => a.start - b.start)
  try { fs.writeFileSync(editsFile(d), JSON.stringify(sorted, null, 2)) } catch { /* ignore */ }
}

export function resetToAuto(d: Date | number) {
  try { fs.rmSync(editsFile(d)) } catch { /* ignore */ }
  clearDayEnded(d)
}

// ---- Feierabend-Marker (Tag beendet) ----

const endedFile = (d: Date | number) => path.join(dataDir(), 'daily', `${dayKey(d)}.ended`)

export function setDayEnded(d: Date | number) {
  try { fs.writeFileSync(endedFile(d), String(Date.now())) } catch { /* ignore */ }
}
export function clearDayEnded(d: Date | number) {
  try { fs.rmSync(endedFile(d)) } catch { /* ignore */ }
}
export function isDayEnded(d: Date | number): boolean {
  return fs.existsSync(endedFile(d))
}

export function dailyDir(): string {
  return path.join(dataDir(), 'daily')
}
