// Electron-Haupteinstieg: Tray, Fenster, IPC, Tracker, Teams-Client.

import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, Notification, dialog, nativeTheme } from 'electron'
import path from 'node:path'
import { loadConfig, saveConfig, isMaterialized, loadStoredSegments, saveSegments, resetToAuto, setDayEnded, clearDayEnded, isDayEnded } from './lib/store'
import { Tracker } from './lib/tracker'
import { TeamsClient } from './lib/teams'
import { segments as deriveDay } from './lib/day'
import { gitEmails } from './lib/git'
import { checkForUpdate } from './lib/updater'
import { computeOvertime, weekWorkedSeconds } from './lib/overtime'
import { reportMarkdown, reportCsv } from './lib/report'
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
function applyBackupTimer() {
  if (backupTimer) { clearInterval(backupTimer); backupTimer = undefined }
  if (config.backup?.auto && config.backup.folder) {
    const ms = Math.max(1, config.backup.intervalHours) * 3600_000
    backupTimer = setInterval(() => autoBackupTo(config.backup.folder, config.backup.keep), ms)
  }
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
let pendingMeeting: { start: number; end: number } | null = null
let lastPromptDay = ''

const graceSeconds = () => Math.max(180, 2 * config.sampleIntervalSeconds)
const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime() }
const dayStr = (ms: number) => new Date(ms).toLocaleDateString('sv-SE')

function openPopup(kind: 'prompt' | 'meeting', payload: Record<string, string>) {
  if (popup) { popup.focus(); return }
  popup = new BrowserWindow({
    width: 360, height: kind === 'meeting' ? 272 : 210,
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

/** Meeting-Segmente im Zeitbereich mit echtem Titel versehen (materialisiert). */
function labelMeeting(startMs: number, endMs: number, title: string) {
  if (!title || title === 'Meeting') return
  const dateMs = startOfDay(startMs)
  const segs = deriveDay(dateMs, Date.now(), graceSeconds())
  const updated = segs.map(s =>
    (s.kind === 'work' && (s.meeting || s.ticket === 'Meeting' || !s.ticket) && s.start < endMs && s.end > startMs)
      ? { ...s, ticket: title, meeting: true } : s)
  saveSegments(dateMs, updated)
  win?.webContents.send('tick')
}

/** Call NICHT als Meeting werten -> Markierung weg, wird zu normaler Arbeitszeit. */
function unlabelMeeting(startMs: number, endMs: number) {
  const dateMs = startOfDay(startMs)
  const segs = deriveDay(dateMs, Date.now(), graceSeconds())
  const updated = segs.map(s =>
    (s.kind === 'work' && (s.meeting || s.ticket === 'Meeting') && s.start < endMs && s.end > startMs)
      ? { ...s, ticket: null, meeting: false } : s)
  saveSegments(dateMs, updated) // coalesce beim Lesen führt es mit der Nachbar-Arbeit zusammen
  win?.webContents.send('tick')
}

function buildSnapshot(): WTSnapshot {
  const today = tracker.daySummary(startOfDay(Date.now()))
  const ot = computeOvertime(config, Date.now(), graceSeconds())
  return {
    status: tracker.displayStatus,
    inCall: tracker.inCall,
    callTitle: tracker.inCall ? (tracker.callLabel ?? 'Meeting') : '',
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
  const statusLabel =
    ds === 'Arbeit' ? '● Arbeitet'
      : ds === 'Pause' ? '◐ Pausiert'
        : ds === 'Feierabend' ? '○ Feierabend'
          : '○ Bereit'
  const menu = Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { label: `Gearbeitet: ${fmt(worked)}`, enabled: false },
    { label: `Pause: ${fmt(paused)}`, enabled: false },
    ...(tracker.inCall ? [{ label: `Im Call: ${tracker.callLabel ?? 'Meeting'}`, enabled: false }] : []),
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
  ipcMain.handle('status', () => ({ status: tracker.status, display: tracker.displayStatus, inCall: tracker.inCall, callLabel: tracker.callLabel, teamsStatus: teams.status }))

  ipcMain.handle('feierabend', () => { endDay(); return true })
  ipcMain.handle('resume-work', () => { resumeDay(); return true })
  ipcMain.handle('pause-work', () => { tracker.pauseWork(); refreshTray(); return true })

  ipcMain.handle('pick-folder', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] })
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
  ipcMain.handle('backup-now', () => autoBackupTo(config.backup.folder, config.backup.keep))
  ipcMain.handle('ai-assign-day', async (_e, dateMs: number) => {
    const segs = deriveDay(dateMs, Date.now(), graceSeconds())
    const dayStart = startOfDay(dateMs)
    const r = await assignTicketsForDay(config.ai, config.projects, segs, dayStart, dayStart + 86400_000)
    if (r.count > 0) { saveSegments(dateMs, r.updated); win?.webContents.send('tick') }
    return { count: r.count, error: r.error }
  })

  ipcMain.handle('popup-result', (_e, kind: string, value: string) => {
    if (kind === 'prompt') {
      // Arbeit -> aktiv lassen; Pause/Privat -> gerade gestartetes Arbeiten verwerfen + Pause halten.
      if (value === 'pause' || value === 'privat') tracker.revertActivation()
      refreshTray()
    } else if (kind === 'meeting' && pendingMeeting) {
      if (value === '__none__') unlabelMeeting(pendingMeeting.start, pendingMeeting.end)
      else labelMeeting(pendingMeeting.start, pendingMeeting.end, value || 'Meeting')
      pendingMeeting = null
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
        openPopup('meeting', { from: String(start), to: String(end) })
      }
    }
    refreshTray()
  })
  tracker.on('activated', ({ reason, breakSeconds }: { reason: string; breakSeconds: number }) => {
    maybePrompt(reason, breakSeconds)
  })
  teams.on('unreachable', () => {
    notify('Teams-API nicht erreichbar',
      'In Teams die Drittanbieter-API aktivieren (Einstellungen → Datenschutz), damit Meetings automatisch erkannt werden.')
  })
  tracker.on('update', () => { refreshTray(); win?.webContents.send('tick'); publishMqtt() })

  setupIpc()
  buildTray()
  applyLaunchAtLogin(config.launchAtLogin)
  if (isDayEnded(startOfDay(Date.now()))) tracker.restoreFeierabend() // Feierabend überlebt Neustart
  tracker.start()
  if (config.detectTeamsApi) teams.start()
  if (config.mqtt?.enabled) mqtt.configure(config.mqtt)
  applyApiServer()
  applyBackupTimer()

  // Update-Check beim Start und alle 6 Stunden.
  setTimeout(() => doCheckUpdate(false), 8000)
  setInterval(() => doCheckUpdate(false), 6 * 3600_000)
  // MQTT regelmäßig auffrischen (Überstunden/Woche ändern sich auch ohne Event).
  setInterval(() => publishMqtt(), 60_000)
})

app.on('window-all-closed', () => { /* Tray-App bleibt aktiv – kein Quit */ })
app.on('before-quit', () => { tracker?.stop(); mqtt?.disconnect(); apiServer?.stop() })

} // Ende Single-Instance-Guard
