// Electron-Haupteinstieg: Tray, Fenster, IPC, Tracker, Teams-Client.

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, Notification, dialog, nativeTheme } from 'electron'
import path from 'node:path'
import { loadConfig, saveConfig, isMaterialized, loadStoredSegments, saveSegments, resetToAuto, setDayEnded, clearDayEnded, isDayEnded, dayKey, setDayAbsence, clearDayAbsence } from './lib/store'
import type { AbsenceType } from './lib/types'
import { Tracker } from './lib/tracker'
import { TeamsClient } from './lib/teams'
import { segments as deriveDay } from './lib/day'
import { gitEmails } from './lib/git'
import { checkForUpdate } from './lib/updater'
import { computeOvertime, weekWorkedSeconds } from './lib/overtime'
import { reportMarkdown, reportCsv, buildMonthReport, buildReport } from './lib/report'
import { MqttPublisher, WTSnapshot } from './lib/mqtt'
import { assignTicketsForDay, testAi, listModels } from './lib/ai'
import { ApiServer } from './lib/apiServer'
import { exportToFile, readBundleFile, restoreBundle, autoBackupTo } from './lib/backup'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { trayIconWork, trayIconPause, trayIconOff } from './lib/trayIcon'
import { AppConfig } from './lib/types'

function notify(title: string, body: string) {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

function applyLaunchAtLogin(enabled: boolean) {
  try { app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true }) } catch { /* ignore */ }
}

function openSettings() {
  createWindow('settings')
}

async function doCheckUpdate(interactive: boolean) {
  const info = await checkForUpdate(app.getVersion())
  if (info.available && info.url) {
    notify('Update verfügbar', `WorkTracker ${info.latest} ist verfügbar (aktuell ${info.current}).`)
    win?.webContents.send('update-available', info)
  } else if (interactive) {
    notify('Kein Update', `Du nutzt bereits die aktuelle Version (${info.current}).`)
  }
  return info
}

let tray: Tray | null = null
let win: BrowserWindow | null = null
let popup: BrowserWindow | null = null
let tracker: Tracker
let teams: TeamsClient
let mqtt: MqttPublisher
let apiServer: ApiServer
let config: AppConfig

let backupTimer: NodeJS.Timeout | undefined
// Ein Auto-Backup ausführen + Zeitstempel merken. `force` überspringt den 2-Min-Doppelschutz.
function runAutoBackup(force = false): { ok: boolean; file?: string; error?: string } {
  if (!config.backup?.auto || !config.backup.folder) return { ok: false, error: 'Auto-Backup aus oder kein Ordner' }
  if (!force && Date.now() - (config.backup.lastBackupTs || 0) < 2 * 60_000) return { ok: true }
  const r = autoBackupTo(config.backup.folder, config.backup.keep)
  if (r.ok) { config.backup.lastBackupTs = Date.now(); saveConfig(config) }
  return r
}
// Zeitbasiert MIT Nachhol-Logik: nur sichern, wenn seit dem letzten Backup das
// Intervall verstrichen ist (fängt ab, dass die App/der Rechner zwischendurch aus war).
function maybeTimeBackup() {
  if (!config.backup?.auto || !config.backup.folder) return
  const iv = config.backup.intervalHours
  if (!iv || iv <= 0) return
  if (Date.now() - (config.backup.lastBackupTs || 0) >= iv * 3600_000) runAutoBackup(true)
}
function applyBackupTimer() {
  if (backupTimer) { clearInterval(backupTimer); backupTimer = undefined }
  if (config.backup?.auto && config.backup.folder) {
    maybeTimeBackup() // sofortiger Nachhol-Check (z. B. App war >24h aus)
    backupTimer = setInterval(maybeTimeBackup, 3600_000) // stündlich prüfen
  }
}

// ---- Monatsbericht ----
function reportsFolder(): string {
  return config.report?.folder?.trim() || path.join(app.getPath('userData'), 'reports')
}
const monthKey = (y: number, m: number) => `${y}-${String(m + 1).padStart(2, '0')}`

/** Einen Monatsbericht (HTML + CSV) erzeugen; gibt den HTML-Pfad zurück oder null (kein Daten-Monat). */
function generateMonthReport(year: number, month: number): string | null {
  const rep = buildMonthReport(year, month, Date.now(), graceSeconds(), config)
  if (rep.totalSeconds <= 0 || rep.workDays === 0) return null // leeren Monat nicht schreiben
  const folder = reportsFolder()
  try {
    fs.mkdirSync(folder, { recursive: true })
    const slug = (config.employeeName || '').trim().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
    const base = `monatsbericht-${rep.key}${slug ? '-' + slug : ''}`
    const htmlPath = path.join(folder, base + '.html')
    fs.writeFileSync(htmlPath, rep.html)
    fs.writeFileSync(path.join(folder, base + '.csv'), rep.csv)
    return htmlPath
  } catch { return null }
}

/** Auswertung über einen frei gewählten Zeitraum erzeugen (HTML + CSV), Pfad zurück. */
function generateRangeReport(fromMs: number, toMs: number): string | null {
  const rep = buildReport(fromMs, toMs, Date.now(), graceSeconds(), config)
  const folder = reportsFolder()
  try {
    fs.mkdirSync(folder, { recursive: true })
    const slug = (config.employeeName || '').trim().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
    const base = `auswertung-${rep.key}${slug ? '-' + slug : ''}`
    const htmlPath = path.join(folder, base + '.html')
    fs.writeFileSync(htmlPath, rep.html)
    fs.writeFileSync(path.join(folder, base + '.csv'), rep.csv)
    return htmlPath
  } catch { return null }
}

function notifyReport(year: number, month: number, htmlPath: string) {
  const label = new Date(year, month, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
  const folder = reportsFolder()
  if (!Notification.isSupported()) return
  const n = new Notification({
    title: `Monatsbericht ${label} erstellt`,
    body: `Liegt in: ${folder}\nKlicken zum Anzeigen im Finder.`,
    actions: [{ type: 'button', text: 'Ordner öffnen' }]
  })
  n.on('click', () => shell.showItemInFolder(htmlPath))
  n.on('action', () => shell.openPath(folder))
  n.show()
}

/** Bei Monatswechsel den/die abgeschlossenen Monat(e) berichten (max. 12 zurück), die noch fehlen. */
function maybeMonthlyReport() {
  if (!config.report?.monthly) return
  const now = new Date()
  const cands: { y: number; m: number; key: string }[] = []
  for (let back = 1; back <= 12; back++) {
    const dt = new Date(now.getFullYear(), now.getMonth() - back, 1)
    const key = monthKey(dt.getFullYear(), dt.getMonth())
    if (config.report.lastMonth && key <= config.report.lastMonth) break
    cands.push({ y: dt.getFullYear(), m: dt.getMonth(), key })
  }
  if (!cands.length) return
  // Erstlauf (noch nie berichtet): nur den jüngsten abgeschlossenen Monat, nicht rückwirkend alles.
  const list = config.report.lastMonth ? cands.reverse() : [cands[0]]
  let newest = config.report.lastMonth || ''
  for (const c of list) {
    const html = generateMonthReport(c.y, c.m)
    if (html) notifyReport(c.y, c.m, html)
    if (c.key > newest) newest = c.key
  }
  config.report.lastMonth = newest || cands[0].key
  saveConfig(config)
}

/** API-Server (neu) konfigurieren – Token sicherstellen, wenn aktiviert. */
function applyApiServer() {
  if (config.apiServer.enabled && !config.apiServer.token) {
    config.apiServer.token = randomUUID().replace(/-/g, '')
    saveConfig(config)
  }
  apiServer.configure(config.apiServer)
}

let callStart: number | null = null          // Beginn des laufenden Calls
let tenHourNotifiedDay = ''                   // Tag, an dem das 10h-Popup schon kam

// Warn-Popup, wenn die gesetzliche Tagesgrenze (ArbZG, Standard 10h) erreicht ist.
function checkDailyLimit() {
  const limit = config.dailyLimitHours
  if (!limit || limit <= 0) return
  if (tracker.displayStatus === 'Feierabend') return
  const dk = dayKey(Date.now())
  if (tenHourNotifiedDay === dk) return
  if (tracker.todaySummary().workedSeconds >= limit * 3600) {
    tenHourNotifiedDay = dk
    openPopup('tenhour', { title: String(limit) })
  }
}
let pendingMeeting: { start: number; end: number } | null = null
let lastPromptDay = ''

const graceSeconds = () => Math.max(180, 2 * config.sampleIntervalSeconds)
const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
const hhmmToMs = (dayBase: number, hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || ''); if (!m) return null
  const d = new Date(dayBase); d.setHours(Number(m[1]), Number(m[2]), 0, 0); return d.getTime()
}
const dayStr = (ms: number) => new Date(ms).toLocaleDateString('sv-SE')

function openPopup(kind: 'prompt' | 'meeting' | 'name' | 'tenhour', payload: Record<string, string>) {
  if (popup) { popup.focus(); return }
  popup = new BrowserWindow({
    width: 360, height: kind === 'meeting' ? 385 : kind === 'name' ? 250 : kind === 'tenhour' ? 240 : 210,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, title: 'WorkTracker',
    // Hintergrund themengerecht – sonst weiße Defaultfarbe (Dark Mode: weiß auf weiß).
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#2c2c2e' : '#f5f5f7',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: false }
  })
  popup.on('closed', () => { popup = null })
  const hash = `popup=${kind}&${new URLSearchParams(payload).toString()}`
  if (process.env['ELECTRON_RENDERER_URL']) popup.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#${hash}`)
  else popup.loadFile(path.join(__dirname, '../renderer/index.html'), { hash })
}

/** Meeting-Segmente im Zeitbereich mit echtem Titel (+ optional Kunde/Projekt) versehen. */
function labelMeeting(startMs: number, endMs: number, title: string, project?: string) {
  if (!title || title === 'Meeting') return
  const dateMs = startOfDay(startMs)
  const segs = deriveDay(dateMs, Date.now(), graceSeconds())
  if (endMs <= startMs) return
  const proj = project?.trim() || null
  const out: ReturnType<typeof deriveDay> = []
  for (const s of segs) {
    if (s.kind !== 'work' || s.end <= startMs || s.start >= endMs) { out.push(s); continue }
    const a = Math.max(s.start, startMs), b = Math.min(s.end, endMs)
    if (s.start < a) out.push({ ...s, id: randomUUID(), end: a })
    out.push({ ...s, id: randomUUID(), start: a, end: b, ticket: title || 'Meeting', meeting: true, project: proj }) // NUR der Call-Bereich
    if (s.end > b) out.push({ ...s, id: randomUUID(), start: b })
  }
  saveSegments(dateMs, out.sort((x, y) => x.start - y.start))
  win?.webContents.send('tick')
}

/** Call NICHT als Meeting werten -> nur der Call-Bereich wird zu normaler Arbeit. */
function unlabelMeeting(startMs: number, endMs: number) {
  if (endMs <= startMs) return
  const dateMs = startOfDay(startMs)
  const segs = deriveDay(dateMs, Date.now(), graceSeconds())
  const out: ReturnType<typeof deriveDay> = []
  for (const s of segs) {
    if (s.kind !== 'work' || s.end <= startMs || s.start >= endMs) { out.push(s); continue }
    const a = Math.max(s.start, startMs), b = Math.min(s.end, endMs)
    if (s.start < a) out.push({ ...s, id: randomUUID(), end: a })
    out.push({ ...s, id: randomUUID(), start: a, end: b, ticket: null, note: null, meeting: false })
    if (s.end > b) out.push({ ...s, id: randomUUID(), start: b })
  }
  saveSegments(dateMs, out.sort((x, y) => x.start - y.start)) // coalesce beim Lesen führt zusammen
  win?.webContents.send('tick')
}

function buildSnapshot(): WTSnapshot {
  const today = tracker.daySummary(startOfDay(Date.now()))
  const ot = computeOvertime(config, Date.now(), graceSeconds())
  return {
    status: tracker.displayStatus,
    inCall: tracker.inCall,
    workedTodayHours: today.workedSeconds / 3600,
    breakTodayMinutes: today.breakSeconds / 60,
    overtimeHours: ot.balanceHours,
    workedWeekHours: weekWorkedSeconds(Date.now(), graceSeconds()) / 3600,
    currentTicket: tracker.currentTicket ?? ''
  }
}

function publishMqtt() {
  if (config.mqtt?.enabled) mqtt.publish(buildSnapshot())
}

/** Feierabend: aktuellen Stand einfrieren + Tag als beendet markieren. */
function endDay() {
  tracker.feierabend()
  const d = startOfDay(Date.now())
  saveSegments(d, deriveDay(d, Date.now(), graceSeconds())) // aktuellen Stand fixieren (inkl. Live-Teil bis jetzt)
  setDayEnded(d)
  refreshTray(); win?.webContents.send('tick'); publishMqtt()
  if (config.backup?.onFeierabend) runAutoBackup(true) // Tag abgeschlossen -> sichern
}

/** Arbeit fortsetzen: Feierabend-Marker entfernen, Live-Erfassung wieder an. */
function resumeDay() {
  clearDayEnded(startOfDay(Date.now()))
  tracker.resumeWork()
  refreshTray(); win?.webContents.send('tick'); publishMqtt()
}

function maybePrompt(reason: string, breakSeconds: number) {
  if (config.promptMode === 'off') return
  const today = dayStr(Date.now())
  let show = false
  if (config.promptMode === 'everyUnlock') show = reason === 'unlock' || reason === 'manual'
  else if (config.promptMode === 'onceADay') show = lastPromptDay !== today
  else if (config.promptMode === 'afterBreaks') show = breakSeconds >= config.promptAfterBreakMinutes * 60
  if (!show) return
  lastPromptDay = today
  openPopup('prompt', {})
}

function createWindow(view?: string) {
  if (win) { win.show(); win.focus(); if (view) win.webContents.send('navigate', view); return }
  const mac = process.platform === 'darwin'
  win = new BrowserWindow({
    width: 1240, height: 740,
    minWidth: 900, minHeight: 520,
    show: false,
    title: 'WorkTracker',
    // Nativer macOS-Look: eingelassene Ampel-Buttons + Vibrancy (Milchglas).
    titleBarStyle: mac ? 'hiddenInset' : 'default',
    trafficLightPosition: mac ? { x: 14, y: 18 } : undefined,
    vibrancy: mac ? 'under-window' : undefined,
    visualEffectState: 'active',
    backgroundColor: mac ? '#00000000' : '#f5f5f7',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })
  win.on('closed', () => { win = null })
  const hash = view ? `view=${view}` : ''
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'] + (hash ? `#${hash}` : ''))
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
  win.once('ready-to-show', () => win?.show())
}

const trayImages: Record<'work' | 'pause' | 'off', Electron.NativeImage> = {} as any
function makeTrayImg(b64: string) {
  const img = nativeImage.createFromDataURL(`data:image/png;base64,${b64}`).resize({ width: 18, height: 18 })
  img.setTemplateImage(true) // macOS passt Hell/Dunkel automatisch an
  return img
}

function buildTray() {
  trayImages.work = makeTrayImg(trayIconWork)
  trayImages.pause = makeTrayImg(trayIconPause)
  trayImages.off = makeTrayImg(trayIconOff)
  tray = new Tray(trayImages.work)
  refreshTray()
  // Kein eigener click-Handler: setContextMenu öffnet bei Klick das Menü
  // (sonst gingen Menü UND Fenster gleichzeitig auf).
}

function refreshTray() {
  if (!tray) return
  const s = tracker.todaySummary()
  const worked = Math.round(s.workedSeconds / 60)
  const paused = Math.round(s.breakSeconds / 60)
  const fmt = (m: number) => m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
  const ds = tracker.displayStatus
  // Icon je Zustand: Arbeit = Aktentasche, Pause = Kaffeetasse, sonst Mond.
  const icon = ds === 'Arbeit' ? trayImages.work : ds === 'Pause' ? trayImages.pause : trayImages.off
  if (icon) tray.setImage(icon)
  const statusBase =
    ds === 'Arbeit' ? '● Arbeitet'
      : ds === 'Pause' ? '◐ Pausiert'
        : ds === 'Feierabend' ? '○ Feierabend'
          : '○ Bereit'
  const statusLabel = tracker.inCall ? `${statusBase} (Call)` : statusBase
  const menu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { label: `Gearbeitet: ${fmt(worked)}`, enabled: false },
    { label: `Pause: ${fmt(paused)}`, enabled: false },
    { type: 'separator' },
    { label: 'Arbeiten', enabled: ds !== 'Arbeit', click: () => resumeDay() },
    { label: 'Pause', enabled: ds === 'Arbeit', click: () => { tracker.pauseWork(); refreshTray() } },
    { label: 'Feierabend', enabled: ds !== 'Feierabend', click: () => endDay() },
    { type: 'separator' },
    { label: 'Kalender öffnen', click: () => createWindow('calendar') },
    { label: 'Einstellungen…', click: () => openSettings() },
    { label: 'Nach Update suchen…', click: () => doCheckUpdate(true) },
    { type: 'separator' },
    { label: 'WorkTracker beenden', click: () => { tracker.stop(); app.quit() } }
  ])
  tray.setToolTip(`WorkTracker – ${statusLabel}`)
  tray.setContextMenu(menu)
}

function setupIpc() {
  ipcMain.handle('get-config', () => config)
  ipcMain.handle('save-config', (_e, c: AppConfig) => {
    config = c; saveConfig(c); tracker.setConfig(c)
    if (c.detectTeamsApi) teams.start(); else teams.stop()
    applyLaunchAtLogin(c.launchAtLogin)
    mqtt.configure(c.mqtt); publishMqtt()
    applyApiServer()
    applyBackupTimer()
    return config
  })
  ipcMain.handle('get-day', (_e, dateMs: number) => {
    return tracker.daySummary(dateMs)
  })
  ipcMain.handle('get-segments', (_e, dateMs: number) => deriveDay(dateMs, Date.now(), graceSeconds()))
  ipcMain.handle('save-segments', (_e, dateMs: number, segs) => { saveSegments(dateMs, segs); return true })
  ipcMain.handle('is-materialized', (_e, dateMs: number) => isMaterialized(dateMs))
  ipcMain.handle('reset-day', (_e, dateMs: number) => { resetToAuto(dateMs); return true })
  // Abwesenheit (Krank/Urlaub) für einen Datumsbereich setzen/entfernen. type=null -> entfernen.
  ipcMain.handle('set-absence', (_e, fromMs: number, toMs: number, type: AbsenceType | null) => {
    const end = startOfDay(Math.max(fromMs, toMs)); let n = 0
    for (const d = new Date(startOfDay(Math.min(fromMs, toMs))); d.getTime() <= end; d.setDate(d.getDate() + 1)) {
      if (type) setDayAbsence(d.getTime(), type); else clearDayAbsence(d.getTime()); n++
    }
    refreshTray(); win?.webContents.send('tick'); publishMqtt()
    return { ok: true, days: n }
  })
  ipcMain.handle('status', () => ({ status: tracker.status, display: tracker.displayStatus, inCall: tracker.inCall, teamsStatus: teams.status }))

  ipcMain.handle('feierabend', () => { endDay(); return true })
  ipcMain.handle('resume-work', () => { resumeDay(); return true })
  ipcMain.handle('pause-work', () => { tracker.pauseWork(); refreshTray(); return true })

  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('git-emails', (_e, repoPath: string) => { try { return gitEmails(repoPath) } catch { return [] } })
  ipcMain.handle('overtime', () => computeOvertime(config, Date.now(), graceSeconds()))
  ipcMain.handle('export-day', async (_e, dateMs: number, format: 'md' | 'csv') => {
    const day = new Date(dateMs).toLocaleDateString('sv-SE')
    const content = format === 'csv'
      ? reportCsv(dateMs, Date.now(), graceSeconds())
      : reportMarkdown(dateMs, Date.now(), graceSeconds(), config)
    const r = await dialog.showSaveDialog({
      defaultPath: `worktracker-${day}.${format}`,
      filters: [format === 'csv' ? { name: 'CSV', extensions: ['csv'] } : { name: 'Markdown', extensions: ['md'] }]
    })
    if (r.canceled || !r.filePath) return false
    try { fs.writeFileSync(r.filePath, content); return true } catch { return false }
  })
  // Auswertung für einen Zeitraum (YYYY-MM-DD .. YYYY-MM-DD) erzeugen + öffnen.
  ipcMain.handle('export-report', (_e, fromStr: string, toStr: string) => {
    const parse = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ''); if (!m) return null; return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() }
    let a = parse(fromStr), b = parse(toStr)
    if (a === null || b === null) return { ok: false, error: 'Datum als YYYY-MM-DD' }
    if (a > b) { const t = a; a = b; b = t }
    const html = generateRangeReport(a, b)
    if (!html) return { ok: false, error: 'Auswertung konnte nicht erstellt werden' }
    shell.openPath(html)
    return { ok: true, file: html, folder: reportsFolder() }
  })
  ipcMain.handle('check-update', () => doCheckUpdate(true))
  ipcMain.handle('open-external', (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('app-version', () => app.getVersion())
  ipcMain.handle('mqtt-test', (_e, mq) => mqtt.test(mq))
  ipcMain.handle('mqtt-status', () => ({ connected: mqtt.connected, status: mqtt.statusText }))
  ipcMain.handle('ai-test', (_e, ai) => testAi(ai))
  ipcMain.handle('ai-models', (_e, ai) => listModels(ai))

  ipcMain.handle('export-backup', async () => {
    const day = new Date().toLocaleDateString('sv-SE')
    const r = await dialog.showSaveDialog({ defaultPath: `worktracker-backup-${day}.json`, filters: [{ name: 'WorkTracker Backup', extensions: ['json'] }] })
    if (r.canceled || !r.filePath) return { ok: false }
    try { exportToFile(r.filePath); return { ok: true, file: r.filePath } } catch (e: any) { return { ok: false, error: String(e?.message || e) } }
  })
  ipcMain.handle('import-backup', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'WorkTracker Backup', extensions: ['json'] }] })
    if (r.canceled || !r.filePaths[0]) return { ok: false }
    const confirm = await dialog.showMessageBox({
      type: 'warning', buttons: ['Abbrechen', 'Überschreiben'], defaultId: 0, cancelId: 0,
      message: 'Sicherung importieren?', detail: 'Die aktuellen Daten (Zeiten, Tickets, Einstellungen) werden mit der Sicherung überschrieben.'
    })
    if (confirm.response !== 1) return { ok: false }
    try {
      const res = restoreBundle(readBundleFile(r.filePaths[0]))
      if (!res.ok) return res
      // Laufenden Zustand neu laden
      config = loadConfig(); tracker.setConfig(config)
      applyLaunchAtLogin(config.launchAtLogin); mqtt.configure(config.mqtt); applyApiServer(); applyBackupTimer()
      refreshTray(); win?.webContents.send('tick'); win?.webContents.send('config-changed')
      return { ok: true }
    } catch (e: any) { return { ok: false, error: String(e?.message || e) } }
  })
  ipcMain.handle('backup-now', () => {
    const r = autoBackupTo(config.backup.folder, config.backup.keep)
    if (r.ok) { config.backup.lastBackupTs = Date.now(); saveConfig(config) }
    return r
  })
  // Monatsbericht für den AKTUELLEN Monat (Stand jetzt) manuell erzeugen.
  ipcMain.handle('report-month-now', () => {
    const now = new Date()
    const html = generateMonthReport(now.getFullYear(), now.getMonth())
    if (!html) return { ok: false, error: 'Kein Bericht – in diesem Monat wurde noch nichts erfasst.' }
    return { ok: true, file: html, folder: reportsFolder() }
  })
  ipcMain.handle('open-reports-folder', async () => {
    const folder = reportsFolder()
    try { fs.mkdirSync(folder, { recursive: true }) } catch { /* */ }
    await shell.openPath(folder)
    return { ok: true, folder }
  })
  ipcMain.handle('ai-assign-day', async (_e, dateMs: number) => {
    const segs = deriveDay(dateMs, Date.now(), graceSeconds())
    const dayStart = startOfDay(dateMs)
    const r = await assignTicketsForDay(config.ai, config.projects, segs, dayStart, dayStart + 86400_000)
    if (r.count > 0) { saveSegments(dateMs, r.updated); win?.webContents.send('tick') }
    return { count: r.count, error: r.error }
  })

  ipcMain.handle('popup-result', (_e, kind: string, value: string, payload?: { from?: string; to?: string; project?: string }) => {
    if (kind === 'prompt') {
      // Arbeit -> sicher (re)aktivieren: falls zwischenzeitlich Feierabend/Pause
      // ausgelöst wurde (z. B. verspätetes Sleep-Event direkt nach dem Aufwachen,
      // Lock, Idle), war das Tracking schon gestoppt -> resumeDay() bringt es zurück.
      // Pause/Privat -> gerade gestartetes Arbeiten verwerfen + Pause halten.
      if (value === 'arbeit') resumeDay()
      else if (value === 'pause' || value === 'privat') tracker.revertActivation()
      refreshTray()
    } else if (kind === 'meeting' && pendingMeeting) {
      let { start, end } = pendingMeeting
      // ggf. im Popup korrigierte Zeiten verwenden (Teams-Erkennung ist nicht immer exakt).
      if (payload?.from && payload?.to) {
        const day = startOfDay(pendingMeeting.start)
        const s = hhmmToMs(day, payload.from), e = hhmmToMs(day, payload.to)
        if (s !== null && e !== null && e > s) { start = s; end = e }
      }
      if (value === '__none__') unlabelMeeting(start, end)
      else labelMeeting(start, end, value || 'Meeting', payload?.project)
      pendingMeeting = null
    } else if (kind === 'name') {
      const name = (value || '').trim()
      if (name) { config.employeeName = name; saveConfig(config); win?.webContents.send('config-changed') }
    } else if (kind === 'tenhour') {
      if (value === 'feierabend') endDay()
    }
    popup?.close()
    return true
  })
}

// Single-Instance: nie zwei Tray-Icons/Fenster gleichzeitig.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => createWindow())

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide() // Menüleisten-App, kein Dock-Icon

  config = loadConfig()
  tracker = new Tracker(config)
  teams = new TeamsClient(app.getVersion())
  mqtt = new MqttPublisher(app.getVersion())
  apiServer = new ApiServer({
    version: app.getVersion(),
    getConfig: () => config,
    deriveDay: (d) => deriveDay(d, Date.now(), graceSeconds()),
    saveDay: (d, s) => saveSegments(d, s),
    resetDay: (d) => resetToAuto(d),
    onChange: () => { refreshTray(); win?.webContents.send('tick') }
  })

  teams.on('change', (inMeeting: boolean) => {
    tracker.setMeeting(inMeeting ? 'Meeting' : null)
    if (inMeeting) {
      callStart = Date.now()
    } else if (callStart) {
      const start = callStart, end = Date.now()
      callStart = null
      if (config.askMeetingTitle && end - start > 60_000) {
        pendingMeeting = { start, end }
        openPopup('meeting', { from: String(start), to: String(end), title: '' }) // Titel wird manuell gesetzt
      }
    }
    refreshTray()
  })
  tracker.on('activated', ({ reason, breakSeconds }: { reason: string; breakSeconds: number }) => {
    maybePrompt(reason, breakSeconds)
    // Neuer Arbeitstag begonnen -> letzten abgeschlossenen Tag sichern, ABER nicht,
    // wenn er bereits per Feierabend gesichert wurde (kein Doppel-Backup desselben Tages).
    if (config.backup?.auto && config.backup.onNewDay && config.backup.folder) {
      const prevDay = startOfDay(Date.now()) - 86400000
      const alreadyByFeierabend = config.backup.onFeierabend && isDayEnded(prevDay)
      const newDaySinceBackup = dayKey(Date.now()) !== (config.backup.lastBackupTs ? dayKey(config.backup.lastBackupTs) : '')
      if (!alreadyByFeierabend && newDaySinceBackup) runAutoBackup(true)
    }
    maybeMonthlyReport() // Monatswechsel -> Bericht des Vormonats
  })
  teams.on('unreachable', () => {
    notify('Teams-API nicht erreichbar',
      'In Teams die Drittanbieter-API aktivieren (Einstellungen → Datenschutz), damit Meetings automatisch erkannt werden.')
  })
  tracker.on('update', () => { refreshTray(); win?.webContents.send('tick'); publishMqtt(); checkDailyLimit() })
  // Keine Sitzung aktiv + Anwesenheit in der Arbeitszeit -> proaktiv zum Start fragen
  // (Erfassung startet nie von allein). promptMode 'off' = nie fragen (Start nur via Tray/App).
  tracker.on('promptStart', () => { if (config.promptMode !== 'off') openPopup('prompt', {}) })

  setupIpc()
  buildTray()
  applyLaunchAtLogin(config.launchAtLogin)
  if (isDayEnded(startOfDay(Date.now()))) tracker.restoreFeierabend() // Feierabend überlebt Neustart
  tracker.start()
  if (config.detectTeamsApi) teams.start()
  if (config.mqtt?.enabled) mqtt.configure(config.mqtt)
  applyApiServer()
  applyBackupTimer()
  setTimeout(() => maybeMonthlyReport(), 5000) // Monatswechsel beim Start prüfen
  setInterval(() => maybeMonthlyReport(), 6 * 3600_000) // + alle 6h (falls App lange läuft)
  // Kein Name gesetzt? -> beim Start danach fragen (für den Monatsbericht).
  if (!config.employeeName?.trim()) setTimeout(() => openPopup('name', {}), 2500)

  // Update-Check beim Start und alle 6 Stunden.
  setTimeout(() => doCheckUpdate(false), 8000)
  setInterval(() => doCheckUpdate(false), 6 * 3600_000)
  // MQTT regelmäßig auffrischen (Überstunden/Woche ändern sich auch ohne Event).
  setInterval(() => { publishMqtt(); checkDailyLimit() }, 60_000)
})

app.on('window-all-closed', () => { /* Tray-App bleibt aktiv – kein Quit */ })
app.on('before-quit', () => { tracker?.stop(); mqtt?.disconnect(); apiServer?.stop() })

} // Ende Single-Instance-Guard
