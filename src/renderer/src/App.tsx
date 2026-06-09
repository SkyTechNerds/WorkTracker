import { useEffect, useState, useCallback, useRef } from 'react'
import { Icon } from './icons'

declare global {
  interface Window {
    wt: {
      getConfig: () => Promise<Cfg>
      saveConfig: (c: Cfg) => Promise<Cfg>
      getDay: (ms: number) => Promise<Summary>
      saveSegments: (ms: number, s: Seg[]) => Promise<any>
      isMaterialized: (ms: number) => Promise<boolean>
      resetDay: (ms: number) => Promise<any>
      status: () => Promise<any>
      feierabend: () => Promise<any>
      resumeWork: () => Promise<any>
      pauseWork: () => Promise<any>
      pickFolder: () => Promise<string | null>
      gitEmails: (repoPath: string) => Promise<string[]>
      overtime: () => Promise<OvertimeResult>
      exportDay: (dateMs: number, format: 'md' | 'csv') => Promise<boolean>
      checkUpdate: () => Promise<any>
      openExternal: (url: string) => Promise<any>
      appVersion: () => Promise<string>
      popupResult: (kind: string, value: string, payload?: { from?: string; to?: string }) => Promise<any>
      mqttTest: (mq: MqttConfig) => Promise<{ ok: boolean; error?: string }>
      mqttStatus: () => Promise<{ connected: boolean; status: string }>
      exportBackup: () => Promise<{ ok: boolean; file?: string; error?: string }>
      importBackup: () => Promise<{ ok: boolean; error?: string }>
      backupNow: () => Promise<{ ok: boolean; file?: string; error?: string }>
      aiTest: (ai: AiConfig) => Promise<{ ok: boolean; error?: string }>
      aiModels: (ai: AiConfig) => Promise<{ models: string[]; error?: string }>
      aiAssignDay: (dateMs: number) => Promise<{ count: number; error?: string }>
      onTick: (cb: () => void) => () => void
      onNavigate: (cb: (view: string) => void) => () => void
      onUpdateAvailable: (cb: (info: any) => void) => () => void
    }
  }
}

const UNASSIGNED = 'Nicht zugewiesen'
const HOUR_H = 80

interface Seg { id: string; start: number; end: number; kind: 'work' | 'break'; ticket?: string | null; note?: string | null; project?: string | null; meeting?: boolean; source: string }
interface Summary { date: number; start?: number; end?: number; workedSeconds: number; breakSeconds: number; segments: Seg[]; materialized: boolean }
interface Project { id: string; name: string; repoPath: string; gitUserEmail: string; color: string }

const PROJECT_COLORS = ['#34c759', '#ff9500', '#ff2d55', '#5ac8fa', '#af52de', '#ffcc00', '#00c7be', '#ff3b30', '#a2845e', '#30b0c7']

function contrastText(hex: string): string {
  const h = hex.replace('#', '')
  if (h.length < 6) return '#fff'
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1d1d1f' : '#ffffff'
}
interface Cfg {
  idleThresholdMinutes: number; sampleIntervalSeconds: number; breakCapMinutes: number
  workdayStartHour: number; workdayEndHour: number; roundingMinutes: number
  promptMode: 'off' | 'onceADay' | 'afterBreaks' | 'everyUnlock'; promptAfterBreakMinutes: number
  endDayOnSleep: boolean; detectTeamsApi: boolean; askMeetingTitle: boolean; launchAtLogin: boolean
  targetHoursPerDay: number; workdayWeekdays: number[]; overtimeStartBalanceHours: number
  projects: Project[]
  mqtt: MqttConfig
  ai: AiConfig
  apiServer: ApiServerConfig
  backup: BackupConfig
}
interface MqttPublishFlags {
  status: boolean; inCall: boolean; callTitle: boolean; workedToday: boolean
  breakToday: boolean; overtimeBalance: boolean; workedWeek: boolean; currentTicket: boolean
}
interface MqttConfig {
  enabled: boolean; host: string; port: number; username: string; password: string
  baseTopic: string; retain: boolean; haDiscovery: boolean; publish: MqttPublishFlags
}
type AiProvider = 'gemini' | 'openai' | 'minimax'
interface AiConfig { enabled: boolean; provider: AiProvider; apiKey: string; model: string }
const AI_DEFAULT_MODEL: Record<AiProvider, string> = { gemini: 'gemini-2.5-flash', openai: 'gpt-4o-mini', minimax: 'MiniMax-Text-01' }
const AI_MODELS: Record<AiProvider, string[]> = {
  gemini: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash-lite', 'gemini-2.0-flash-001'],
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
  minimax: ['MiniMax-Text-01', 'MiniMax-M1']
}
const AI_KEY_URL: Record<AiProvider, string> = {
  gemini: 'https://aistudio.google.com/app/apikey',
  openai: 'https://platform.openai.com/api-keys',
  minimax: 'https://www.minimax.io/platform'
}
const AI_PROVIDER_LABEL: Record<AiProvider, string> = { gemini: 'Google Gemini', openai: 'OpenAI', minimax: 'MiniMax' }
interface ApiServerConfig { enabled: boolean; port: number; token: string }
interface BackupConfig { auto: boolean; intervalHours: number; folder: string; keep: number }
interface OvertimeDay { date: number; workedHours: number; targetHours: number; deltaHours: number; isWorkday: boolean }
interface OvertimeResult { balanceHours: number; days: OvertimeDay[] }

const DEFAULT_CFG: Cfg = {
  idleThresholdMinutes: 6, sampleIntervalSeconds: 60, breakCapMinutes: 30,
  workdayStartHour: 6, workdayEndHour: 20, roundingMinutes: 15,
  promptMode: 'afterBreaks', promptAfterBreakMinutes: 20,
  endDayOnSleep: true, detectTeamsApi: false, askMeetingTitle: true, launchAtLogin: true,
  targetHoursPerDay: 8, workdayWeekdays: [2, 3, 4, 5, 6], overtimeStartBalanceHours: 0,
  projects: [],
  mqtt: {
    enabled: false, host: '', port: 1883, username: '', password: '',
    baseTopic: 'worktracker', retain: true, haDiscovery: true,
    publish: { status: true, inCall: true, callTitle: true, workedToday: true, breakToday: false, overtimeBalance: true, workedWeek: true, currentTicket: false }
  },
  ai: { enabled: false, provider: 'gemini', apiKey: '', model: 'gemini-2.5-flash' },
  apiServer: { enabled: false, port: 8787, token: '' },
  backup: { auto: false, intervalHours: 24, folder: '', keep: 14 }
}

function hm(seconds: number): string {
  const t = Math.round(seconds); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}
function hmSigned(hours: number): string {
  const s = hours < 0 ? '−' : '+'; const a = Math.abs(hours)
  const h = Math.floor(a), m = Math.round((a - h) * 60)
  return `${s}${h}h ${m}m`
}
function clock(ms: number): string {
  const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function uuid() { return crypto.randomUUID() }

// ---- Root: View-Umschaltung + Update-Banner ----
export function App({ initialView }: { initialView?: string }) {
  const [view, setView] = useState<'calendar' | 'overtime' | 'settings'>(
    initialView === 'settings' || initialView === 'overtime' ? initialView : 'calendar')
  const [update, setUpdate] = useState<any>(null)
  useEffect(() => {
    const offNav = window.wt.onNavigate(v => setView(v as any))
    const offUp = window.wt.onUpdateAvailable(info => setUpdate(info))
    return () => { offNav(); offUp() }
  }, [])
  return (
    <div className="app">
      <div className="nav">
        <button className={view === 'calendar' ? 'on' : ''} onClick={() => setView('calendar')}>Kalender</button>
        <button className={view === 'overtime' ? 'on' : ''} onClick={() => setView('overtime')}>Überstunden</button>
        <button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')}>Einstellungen</button>
        <div className="spacer" />
        {update?.available && <a href="#" className="update" onClick={e => { e.preventDefault(); window.wt.openExternal(update.url) }}><Icon name="update" size={14} /> Update {update.latest}</a>}
      </div>
      {view === 'calendar' && <CalendarView />}
      {view === 'overtime' && <OvertimeView />}
      {view === 'settings' && <SettingsView />}
    </div>
  )
}

function CalendarView() {
  const [segments, setSegments] = useState<Seg[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [status, setStatus] = useState<any>({})
  const [cfg, setCfg] = useState<Cfg>(DEFAULT_CFG)
  const [dateMs, setDateMs] = useState(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() })
  const [editing, setEditing] = useState<Seg | null>(null)
  const [assignKey, setAssignKey] = useState<string | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [rangeOpen, setRangeOpen] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiMsg, setAiMsg] = useState('')
  // Hover-Verknüpfung Sidebar <-> Kalender. Pause = eigenes Segment, Arbeit/Meeting = Ticket.
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  const segKey = (s: Seg) => s.kind === 'break' ? 's:' + s.id : 't:' + (s.ticket || UNASSIGNED)
  useEffect(() => {
    if (!exportOpen) return
    const h = () => setExportOpen(false)
    window.addEventListener('click', h)
    return () => window.removeEventListener('click', h)
  }, [exportOpen])

  const runAi = async () => {
    setAiBusy(true); setAiMsg('')
    const r = await window.wt.aiAssignDay(dateMs)
    setAiBusy(false)
    setAiMsg(r.error ? r.error : `${r.count} Block(e) zugeordnet`)
    setTimeout(() => setAiMsg(''), 5000)
    await load()
  }

  const snapMin = cfg.roundingMinutes > 0 ? cfg.roundingMinutes : 15

  const load = useCallback(async () => {
    const s = await window.wt.getDay(dateMs)
    setSummary(s); setSegments(s.segments)
    setStatus(await window.wt.status())
  }, [dateMs])

  useEffect(() => { window.wt.getConfig().then(setCfg) }, [])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    const off = window.wt.onTick(() => { if (!editing && !assignKey && !drag.current) load() })
    const iv = setInterval(() => { if (!editing && !assignKey && !drag.current) load() }, 30000)
    return () => { off(); clearInterval(iv) }
  }, [load, editing, assignKey])

  const persist = async (segs: Seg[]) => { await window.wt.saveSegments(dateMs, segs); await load() }

  // ---- Drag (move / resize) ----
  const drag = useRef<null | { id: string; mode: 'move' | 'top' | 'bottom'; origStart: number; origEnd: number; startY: number; moved: boolean; neighborId: string | null }>(null)
  const [, force] = useState(0)

  const snapMs = (ms: number) => Math.round(ms / (snapMin * 60000)) * (snapMin * 60000)

  const onPointerDown = (e: React.PointerEvent, seg: Seg, mode: 'move' | 'top' | 'bottom') => {
    e.stopPropagation()
    // Angrenzenden Block an der gezogenen Grenze merken (für verknüpftes Resizen).
    let neighborId: string | null = null
    if (mode === 'bottom') neighborId = segments.find(s => s.id !== seg.id && Math.abs(s.start - seg.end) < 1000)?.id ?? null
    else if (mode === 'top') neighborId = segments.find(s => s.id !== seg.id && Math.abs(s.end - seg.start) < 1000)?.id ?? null
    drag.current = { id: seg.id, mode, origStart: seg.start, origEnd: seg.end, startY: e.clientY, moved: false, neighborId }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current; if (!d) return
    const deltaMs = (e.clientY - d.startY) / HOUR_H * 3600000
    if (Math.abs(e.clientY - d.startY) > 3) d.moved = true
    const ds = snapMs(deltaMs)
    const MIN = 5 * 60000
    const dayStart = dateMs, dayEnd = dateMs + 86400000
    setSegments(prev => {
      const others = prev.filter(s => s.id !== d.id)
      const below = others.filter(s => s.end <= d.origStart + 1).reduce((m, s) => Math.max(m, s.end), dayStart)
      const above = others.filter(s => s.start >= d.origEnd - 1).reduce((m, s) => Math.min(m, s.start), dayEnd)
      const neighbor = d.neighborId ? prev.find(s => s.id === d.neighborId) : undefined

      if (d.mode === 'move') {
        const dur = d.origEnd - d.origStart
        const ns = Math.max(below, Math.min(d.origStart + ds, above - dur))
        return prev.map(s => s.id === d.id ? { ...s, start: ns, end: ns + dur } : s)
      }
      if (d.mode === 'top') {
        // Grenze nach oben ziehen: dragged.start + ggf. Vorgänger.end bewegen sich gemeinsam.
        const lower = neighbor ? neighbor.start + MIN : below
        const boundary = Math.max(lower, Math.min(d.origStart + ds, d.origEnd - MIN))
        return prev.map(s =>
          s.id === d.id ? { ...s, start: boundary }
            : (neighbor && s.id === neighbor.id ? { ...s, end: boundary } : s))
      }
      // bottom: dragged.end + ggf. Nachfolger.start bewegen sich gemeinsam.
      const upper = neighbor ? neighbor.end - MIN : above
      const boundary = Math.min(upper, Math.max(d.origEnd + ds, d.origStart + MIN))
      return prev.map(s =>
        s.id === d.id ? { ...s, end: boundary }
          : (neighbor && s.id === neighbor.id ? { ...s, start: boundary } : s))
    })
    force(x => x + 1)
  }
  const onPointerUp = () => {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    const d = drag.current; drag.current = null
    if (!d) return
    if (!d.moved) { const seg = segments.find(s => s.id === d.id); if (seg) setEditing(seg); return }
    persist(segments) // segments already updated by move
  }

  // ---- Edit / assign ops ----
  const saveEdit = (seg: Seg) => {
    const exists = segments.some(s => s.id === seg.id)
    const list = exists ? segments.map(s => s.id === seg.id ? seg : s) : [...segments, { ...seg, source: 'manual' }]
    setEditing(null); persist(list)
  }
  // Löschen ohne Lücke: angrenzenden Block über den freigewordenen Bereich ziehen.
  const deleteFilling = (id: string): Seg[] => {
    const sorted = [...segments].sort((a, b) => a.start - b.start)
    const i = sorted.findIndex(s => s.id === id)
    if (i < 0) return segments
    const seg = sorted[i], prev = sorted[i - 1], next = sorted[i + 1]
    let list = segments.filter(s => s.id !== id)
    if (prev && Math.abs(prev.end - seg.start) < 1000) list = list.map(s => s.id === prev.id ? { ...s, end: seg.end } : s)
    else if (next && Math.abs(next.start - seg.end) < 1000) list = list.map(s => s.id === next.id ? { ...s, start: seg.start } : s)
    return list
  }
  const deleteSeg = (id: string) => { setEditing(null); persist(deleteFilling(id)) }

  const assign = (group: string, ticket: string, note: string, project: string, from: number | null, to: number | null) => {
    setAssignKey(null)
    const t = ticket.trim(); const n = note.trim(); const pr = project || null
    const patch = (s: Seg): Seg => ({ ...s, ticket: t || null, note: n || s.note, project: pr, meeting: pr ? false : s.meeting })
    if (from === null || to === null || to <= from) {
      // ganze Gruppe umbenennen
      persist(segments.map(s => (s.kind === 'work' && (s.ticket || UNASSIGNED) === group) ? patch(s) : s))
      return
    }
    const out: Seg[] = []
    for (const s of segments) {
      if (s.kind !== 'work' || (s.ticket || UNASSIGNED) !== group) { out.push(s); continue }
      const a = Math.max(s.start, from), b = Math.min(s.end, to)
      if (a >= b) { out.push(s); continue }
      if (s.start < a) out.push({ ...s, id: uuid(), end: a })
      out.push({ ...patch(s), id: uuid(), start: a, end: b, source: 'manual' })
      if (s.end > b) out.push({ ...s, id: uuid(), start: b })
    }
    persist(out)
  }

  // Ticket auf einen Zeitraum buchen: nur Arbeitsblöcke (keine Pause/Meeting)
  // im Bereich werden gesetzt – Pausen dazwischen bleiben erhalten (abgezogen).
  const assignRange = (a: number, b: number, ticket: string, note: string, project: string) => {
    setRangeOpen(false)
    if (b <= a) return
    const t = ticket.trim(); const n = note.trim(); const pr = project || null
    const mk = (x: number, y: number): Seg => ({ id: uuid(), start: x, end: y, kind: 'work', ticket: t || null, note: n || null, project: pr, meeting: false, source: 'manual' })
    const protectedIvs: Array<[number, number]> = []
    const out: Seg[] = []
    for (const s of segments) {
      if (s.end <= a || s.start >= b) { out.push(s); continue }
      if (s.kind === 'break' || s.meeting) {           // Pausen/Meetings bleiben erhalten
        out.push(s)
        protectedIvs.push([Math.max(s.start, a), Math.min(s.end, b)])
      } else {                                          // Arbeit im Bereich wird ersetzt
        if (s.start < a) out.push({ ...s, id: uuid(), end: a })
        if (s.end > b) out.push({ ...s, id: uuid(), start: b })
      }
    }
    // [a,b] abzüglich Pausen/Meetings mit dem Ticket füllen (auch Lücken)
    protectedIvs.sort((x, y) => x[0] - y[0])
    let cur = a
    for (const [ps, pe] of protectedIvs) { if (ps > cur) out.push(mk(cur, ps)); cur = Math.max(cur, pe) }
    if (cur < b) out.push(mk(cur, b))
    persist(out.sort((x, y) => x.start - y.start))
  }

  // ---- Render ----
  const { workdayStartHour: sh, workdayEndHour: eh } = cfg
  const yOff = (ms: number) => { const d = new Date(ms); return ((d.getHours() * 60 + d.getMinutes()) - sh * 60) / 60 * HOUR_H }
  const projColor = (name?: string | null) => name ? cfg.projects.find(p => p.name === name)?.color : undefined

  // Nach Projekt/Kunde gruppieren, je Gruppe die Tickets einzeln.
  const ticketGroups = (() => {
    type G = { key: string; name: string; color: string; total: number; tickets: Record<string, number> }
    const map: Record<string, G> = {}
    for (const s of segments) {
      if (s.kind !== 'work') continue
      let key: string, name: string, color: string
      if (s.meeting) { key = '__meet'; name = 'Meetings'; color = 'var(--block-meeting)' }
      else if (s.project) { key = 'p:' + s.project; name = s.project; color = projColor(s.project) || 'var(--block-work)' }
      else { key = '__none'; name = 'Ohne Projekt'; color = 'var(--block-work)' }
      const g = map[key] || (map[key] = { key, name, color, total: 0, tickets: {} })
      const secs = (s.end - s.start) / 1000
      g.total += secs
      const tk = s.ticket || UNASSIGNED
      g.tickets[tk] = (g.tickets[tk] || 0) + secs
    }
    return Object.values(map).sort((a, b) => b.total - a.total)
  })()

  const breaks = segments.filter(s => s.kind === 'break' && s.end > s.start).sort((a, b) => a.start - b.start)
  const breakTotal = breaks.reduce((a, s) => a + (s.end - s.start) / 1000, 0)
  // Pause „löschen" = in Arbeit umwandeln (verschmilzt mit Nachbarblöcken).
  const removeBreak = (id: string) => persist(segments.map(s => s.id === id ? { ...s, kind: 'work', ticket: null, note: null, project: null, meeting: undefined } : s))
  // Ticket „löschen" = alle Blöcke dieses Tickets aus dem Tag entfernen.
  const deleteTicket = (tk: string) => {
    if (!window.confirm(`Alle Einträge von „${tk}" aus diesem Tag löschen?`)) return
    persist(segments.filter(s => !(s.kind === 'work' && (s.ticket || UNASSIGNED) === tk)))
  }

  const isToday = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() === dateMs })()
  // Aktuell laufender Block heute = letzter Arbeitsblock (wenn „Arbeitet")
  // bzw. letzter Pausenblock (wenn „Pausiert").
  const liveKind: 'work' | 'break' | null = isToday
    ? (status?.display === 'Arbeit' ? 'work' : status?.display === 'Pause' ? 'break' : null) : null
  const liveId = liveKind
    ? segments.filter(s => s.kind === liveKind).reduce<Seg | null>((a, s) => (!a || s.end > a.end ? s : a), null)?.id
    : undefined

  return (
    <div className="view">
      <div className="topbar">
        <button className="ico" title="Vorheriger Tag" onClick={() => setDateMs(dateMs - 86400000)}><Icon name="chevronL" /></button>
        <button className="ico" title="Heute" onClick={() => { const d = new Date(); d.setHours(0, 0, 0, 0); setDateMs(d.getTime()) }}><Icon name="today" /></button>
        <button className="ico" title="Nächster Tag" onClick={() => setDateMs(dateMs + 86400000)}><Icon name="chevronR" /></button>
        <b>{new Date(dateMs).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' })}</b>
        {summary?.materialized && <span className="metric edited"><Icon name="pencil" size={13} /> bearbeitet
          <button className="ico reset-btn" title="Auf automatische Erfassung zurücksetzen (manuelle Änderungen verwerfen)"
            onClick={async () => { if (!window.confirm('Diesen Tag auf automatische Erfassung zurücksetzen? Alle manuellen Einträge/Zuweisungen dieses Tages gehen verloren.')) return; await window.wt.resetDay(dateMs); load() }}><Icon name="reset" size={14} /></button></span>}
        <div className="spacer" />
        {summary && <>
          <span className="metric"><Icon name="clock" /> {summary.start ? clock(summary.start) : '–'}–{summary.end ? clock(summary.end) : '–'}</span>
          <span className="metric"><Icon name="briefcase" /> <b>{hm(summary.workedSeconds)}</b></span>
          <span className="metric"><Icon name="coffee" /> {hm(summary.breakSeconds)}</span>
        </>}
        {status?.inCall && <span className="metric"><Icon name="phone" /> {status.callLabel || 'Meeting'}</span>}
        {isToday && <>
          <button className="ico" title="Arbeiten" disabled={status?.display === 'Arbeit'} onClick={async () => { await window.wt.resumeWork(); load() }}><Icon name="play" /></button>
          <button className="ico" title="Pause" disabled={status?.display !== 'Arbeit'} onClick={async () => { await window.wt.pauseWork(); load() }}><Icon name="pause" /></button>
          <button className="ico" title="Feierabend" disabled={status?.display === 'Feierabend'} onClick={async () => { await window.wt.feierabend(); load() }}><Icon name="moon" /></button>
        </>}
        {cfg.ai?.enabled && aiMsg && <span className="metric ai-msg">{aiMsg}</span>}
        <span className="tb-sep" />
        {cfg.ai?.enabled && <button className="ico" title="KI: Tickets aus Commits zuordnen" disabled={aiBusy} onClick={runAi}>{aiBusy ? <span className="spin"><Icon name="spinner" /></span> : <Icon name="sparkles" />}</button>}
        <button className="ico" title="Ticket auf Zeitraum buchen (Von–Bis, Pausen werden abgezogen)" onClick={() => setRangeOpen(true)}><Icon name="tag" /></button>
        <button className="ico" title="Einzelnen Eintrag hinzufügen" onClick={() => { const d = new Date(dateMs); d.setHours(9, 0, 0, 0); const e = new Date(dateMs); e.setHours(10, 0, 0, 0); setEditing({ id: uuid(), start: d.getTime(), end: e.getTime(), kind: 'work', source: 'manual' }) }}><Icon name="plus" /></button>
        <span className="export-wrap" onClick={e => e.stopPropagation()}>
          <button className="ico" title="Exportieren" onClick={() => setExportOpen(v => !v)}><Icon name="download" /></button>
          {exportOpen && <div className="export-menu">
            <button onClick={() => { window.wt.exportDay(dateMs, 'md'); setExportOpen(false) }}>Markdown (.md)</button>
            <button onClick={() => { window.wt.exportDay(dateMs, 'csv'); setExportOpen(false) }}>CSV (.csv)</button>
          </div>}
        </span>
      </div>

      <div className="body">
        <div className="timeline">
          <div className="tl-inner" style={{ height: (eh - sh) * HOUR_H + 16 }}>
            {Array.from({ length: eh - sh + 1 }, (_, i) => sh + i).map(h => (
              <div key={h}>
                <div className="hour-line" style={{ top: (h - sh) * HOUR_H }} />
                <div className="hour-label" style={{ top: (h - sh) * HOUR_H }}>{String(h).padStart(2, '0')}:00</div>
              </div>
            ))}
            {[...segments].sort((a, b) => a.start - b.start).map((s, i, arr) => {
              const top = yOff(s.start)
              const actual = (s.end - s.start) / 3600000 * HOUR_H
              let height = Math.max(20, actual)
              const next = arr[i + 1]
              if (next) height = Math.min(height, Math.max(3, yOff(next.start) - top)) // nie über den nächsten Block
              const isMeeting = s.kind === 'work' && !!s.meeting
              const isLive = s.id === liveId
              const baseTitle = s.kind === 'break' ? 'Pause' : (s.ticket || (isMeeting ? 'Meeting' : 'Arbeit'))
              const title = isLive ? `${baseTitle} – ${s.kind === 'break' ? 'läuft' : 'aktiv'}` : baseTitle
              const pc = s.kind === 'work' && !isMeeting ? projColor(s.project) : undefined
              const style: React.CSSProperties = { top, height }
              if (isMeeting) { style.background = 'var(--block-meeting)'; style.color = '#fff' }
              else if (pc) { style.background = pc; style.color = contrastText(pc) }
              return (
                <div key={s.id} className={`block ${s.kind} ${isLive ? 'live' : ''} ${hoverKey ? (hoverKey === segKey(s) ? 'hl' : 'dim') : ''}`} style={style}
                  onPointerDown={e => onPointerDown(e, s, 'move')}
                  onMouseEnter={() => setHoverKey(segKey(s))} onMouseLeave={() => setHoverKey(null)}
                  title={s.note ? `${title} — ${s.note}` : title}>
                  <div className="handle top" onPointerDown={e => onPointerDown(e, s, 'top')} />
                  <div className="blk-row"><span className="title">{title}</span>{height >= 18 && <span className="time">{clock(s.start)}–{clock(s.end)}</span>}</div>
                  {height >= 42 && s.note && <div className="note">{s.note}</div>}
                  <div className="handle bottom" onPointerDown={e => onPointerDown(e, s, 'bottom')} />
                </div>
              )
            })}
          </div>
        </div>

        <div className="sidebar">
          <h3>Zeit je Ticket</h3>
          {ticketGroups.length === 0 && <div className="ticket-row">keine Arbeitszeit</div>}
          {ticketGroups.map(g => (
            <div key={g.key} className="ticket-group">
              <div className="group-head">
                <span className="tk"><span className="dot" style={{ background: g.color }} /><b>{g.name}</b></span>
                <span className="secs">{hm(g.total)}</span>
              </div>
              {Object.entries(g.tickets).sort((a, b) => b[1] - a[1]).map(([tk, secs]) => (
                <div key={tk} className={`ticket-row sub ${tk === UNASSIGNED ? 'unassigned' : ''} ${hoverKey ? (hoverKey === 't:' + tk ? 'hl' : 'dim') : ''}`}
                  onMouseEnter={() => setHoverKey('t:' + tk)} onMouseLeave={() => setHoverKey(null)}>
                  <span className="tk-name">{tk}</span>
                  <span className="secs">{hm(secs)}
                    <button className="row-act" title="Bearbeiten / Zeit hinzufügen" onClick={() => setAssignKey(tk)}><Icon name="pencil" size={13} /></button>
                    <button className="row-act danger" title="Löschen" onClick={() => deleteTicket(tk)}><Icon name="trash" size={13} /></button>
                  </span>
                </div>
              ))}
            </div>
          ))}

          {breaks.length > 0 && (
            <div className="ticket-group">
              <div className="group-head">
                <span className="tk"><span className="dot" style={{ background: 'var(--block-break)' }} /><b>Pausen</b></span>
                <span className="secs">{hm(breakTotal)}</span>
              </div>
              {breaks.map(b => (
                <div key={b.id} className={`ticket-row sub ${hoverKey ? (hoverKey === 's:' + b.id ? 'hl' : 'dim') : ''}`}
                  onMouseEnter={() => setHoverKey('s:' + b.id)} onMouseLeave={() => setHoverKey(null)}>
                  <span className="tk-name">{clock(b.start)}–{clock(b.end)}</span>
                  <span className="secs">{hm((b.end - b.start) / 1000)}
                    <button className="row-act" title="Pause bearbeiten" onClick={() => setEditing(b)}><Icon name="pencil" size={13} /></button>
                    <button className="row-act danger" title="Pause löschen (wird zu Arbeitszeit)" onClick={() => removeBreak(b.id)}><Icon name="trash" size={13} /></button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {editing && <BlockEditor seg={editing} projects={cfg.projects} onSave={saveEdit} onDelete={deleteSeg} onCancel={() => setEditing(null)} />}
      {assignKey && <TicketDetail group={assignKey} segments={segments} projects={cfg.projects}
        onAdd={(from, to, note, project) => assignRange(setTime(dateMs, from), setTime(dateMs, to), assignKey === UNASSIGNED ? '' : assignKey, note, project)}
        onDelete={(id) => persist(deleteFilling(id))}
        onRename={(ticket, note, project) => assign(assignKey, ticket, note, project, null, null)}
        onCancel={() => setAssignKey(null)} />}
      {rangeOpen && <RangeAssign projects={cfg.projects}
        defFrom={summary?.start ? clock(summary.start) : '09:00'}
        defTo={summary?.end ? clock(summary.end) : '17:00'}
        onSave={(t, n, p, from, to) => assignRange(setTime(dateMs, from), setTime(dateMs, to), t, n, p)}
        onCancel={() => setRangeOpen(false)} />}
    </div>
  )
}

// ---- Block-Editor ----
function timeInput(ms: number): string { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
function setTime(baseMs: number, hhmm: string): number { const [h, m] = hhmm.split(':').map(Number); const d = new Date(baseMs); d.setHours(h || 0, m || 0, 0, 0); return d.getTime() }

function BlockEditor({ seg, projects, onSave, onDelete, onCancel }: { seg: Seg; projects: Project[]; onSave: (s: Seg) => void; onDelete: (id: string) => void; onCancel: () => void }) {
  const [type, setType] = useState<'work' | 'break' | 'meeting'>(seg.kind === 'break' ? 'break' : (seg.meeting ? 'meeting' : 'work'))
  const [from, setFrom] = useState(timeInput(seg.start))
  const [to, setTo] = useState(timeInput(seg.end))
  const [ticket, setTicket] = useState(seg.ticket || '')
  const [note, setNote] = useState(seg.note || '')
  const [project, setProject] = useState(seg.project || '')
  const save = () => {
    const isBreak = type === 'break', isMeeting = type === 'meeting'
    onSave({
      ...seg, kind: isBreak ? 'break' : 'work', meeting: isMeeting,
      start: setTime(seg.start, from), end: setTime(seg.end, to),
      ticket: isBreak ? null : (ticket || null), note: note || null,
      project: (isBreak || isMeeting) ? null : (project || null)
    })
  }
  return (
    <Modal title="Eintrag bearbeiten" onCancel={onCancel}>
      <label>Art <select value={type} onChange={e => setType(e.target.value as any)}>
        <option value="work">Arbeit</option><option value="meeting">Meeting</option><option value="break">Pause</option></select></label>
      <div className="grid2"><label>Von <input type="time" value={from} onChange={e => setFrom(e.target.value)} /></label><label>Bis <input type="time" value={to} onChange={e => setTo(e.target.value)} /></label></div>
      {type !== 'break' && <>
        <label>Ticket / Titel <input value={ticket} onChange={e => setTicket(e.target.value)} placeholder={type === 'meeting' ? 'z. B. Jumo Daily' : 'z. B. PROJ-123'} /></label>
        {type === 'work' && projects.length > 0 && <label>Projekt (Farbe)
          <select value={project} onChange={e => setProject(e.target.value)}>
            <option value="">– keins –</option>
            {projects.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
          </select></label>}
        <label>Beschreibung <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} /></label></>}
      <div className="actions"><button className="danger" onClick={() => onDelete(seg.id)}>Löschen</button><span style={{ flex: 1 }} /><button onClick={onCancel}>Abbrechen</button><button className="primary" onClick={save}>Sichern</button></div>
    </Modal>
  )
}

// ---- Ticket-Zuweisung (mit Von/Bis) ----
function TicketAssign({ group, segments, projects, onSave, onCancel }: { group: string; segments: Seg[]; projects: Project[]; onSave: (g: string, t: string, n: string, project: string, from: number | null, to: number | null) => void; onCancel: () => void }) {
  const groupSegs = segments.filter(s => s.kind === 'work' && (s.ticket || UNASSIGNED) === group)
  const rStart = groupSegs.length ? Math.min(...groupSegs.map(s => s.start)) : Date.now()
  const rEnd = groupSegs.length ? Math.max(...groupSegs.map(s => s.end)) : Date.now()
  const isUnassigned = group === UNASSIGNED
  const [ticket, setTicket] = useState(isUnassigned ? '' : group)
  const [note, setNote] = useState(groupSegs.find(s => s.note)?.note || '')
  const [project, setProject] = useState(groupSegs.find(s => s.project)?.project || '')
  const [useRange, setUseRange] = useState(isUnassigned)
  const [from, setFrom] = useState(timeInput(rStart))
  const [to, setTo] = useState(timeInput(rEnd))
  const save = () => {
    const r = isUnassigned && useRange
    onSave(group, ticket, note, project, r ? setTime(rStart, from) : null, r ? setTime(rEnd, to) : null)
  }
  return (
    <Modal title={isUnassigned ? 'Ticket zuweisen' : 'Ticket bearbeiten'} onCancel={onCancel}>
      <label>Ticket / Titel <input value={ticket} onChange={e => setTicket(e.target.value)} placeholder="z. B. PROJ-123 oder Meeting" /></label>
      {projects.length > 0 && <label>Projekt / Kunde (Farbe)
        <select value={project} onChange={e => setProject(e.target.value)}>
          <option value="">– keins –</option>
          {projects.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
        </select></label>}
      <label>Beschreibung <textarea value={note} onChange={e => setNote(e.target.value)} rows={3} /></label>
      {isUnassigned && <label className="check"><input type="checkbox" checked={useRange} onChange={e => setUseRange(e.target.checked)} /> Nur einen Zeitbereich zuweisen</label>}
      {isUnassigned && useRange && <div className="grid2"><label>Von <input type="time" value={from} onChange={e => setFrom(e.target.value)} /></label><label>Bis <input type="time" value={to} onChange={e => setTo(e.target.value)} /></label></div>}
      <div className="actions"><span style={{ flex: 1 }} /><button onClick={onCancel}>Abbrechen</button><button className="primary" onClick={save}>Sichern</button></div>
    </Modal>
  )
}

// ---- Ticket-Detail: Zeitspannen + Gesamtzeit, Zeit hinzufügen/entfernen ----
function TicketDetail({ group, segments, projects, onAdd, onDelete, onRename, onCancel }: {
  group: string; segments: Seg[]; projects: Project[]
  onAdd: (from: string, to: string, note: string, project: string) => void
  onDelete: (id: string) => void
  onRename: (ticket: string, note: string, project: string) => void
  onCancel: () => void
}) {
  const isUnassigned = group === UNASSIGNED
  const groupSegs = segments.filter(s => s.kind === 'work' && (s.ticket || UNASSIGNED) === group).sort((a, b) => a.start - b.start)
  const total = groupSegs.reduce((acc, s) => acc + (s.end - s.start) / 1000, 0)
  const [ticket, setTicket] = useState(isUnassigned ? '' : group)
  const [project, setProject] = useState(groupSegs.find(s => s.project)?.project || '')
  const [note, setNote] = useState(groupSegs.find(s => s.note)?.note || '')
  const [adding, setAdding] = useState(false)
  const lastEnd = groupSegs.length ? groupSegs[groupSegs.length - 1].end : 0
  const [from, setFrom] = useState(lastEnd ? clock(lastEnd) : '13:00')
  const [to, setTo] = useState(lastEnd ? clock(lastEnd + 3600000) : '14:00')

  return (
    <Modal title={isUnassigned ? 'Nicht zugewiesen' : group} onCancel={onCancel}>
      <label>Ticket / Titel <input value={ticket} onChange={e => setTicket(e.target.value)} placeholder="z. B. WCMS-2607" /></label>
      {projects.length > 0 && <label>Projekt / Kunde (Farbe)
        <select value={project} onChange={e => setProject(e.target.value)}>
          <option value="">– keins –</option>
          {projects.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
        </select></label>}
      <label>Beschreibung (was wurde gemacht) <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="z. B. Hero-Section umgesetzt" /></label>

      <div className="ranges">
        {groupSegs.map(s => (
          <div className="range-row" key={s.id}>
            <span className="rg-time">{clock(s.start)}–{clock(s.end)}</span>
            <span className="rg-dur">{hm((s.end - s.start) / 1000)}</span>
            <button className="rg-x" title="Diese Zeit entfernen" onClick={() => onDelete(s.id)}>✕</button>
          </div>
        ))}
        {groupSegs.length === 0 && <div className="range-row rg-empty">noch keine Zeit gebucht</div>}
      </div>
      <div className="range-total">Gesamt heute <b>{hm(total)}</b></div>

      {adding
        ? <div className="rg-add">
            <input type="time" value={from} onChange={e => setFrom(e.target.value)} />
            <input type="time" value={to} onChange={e => setTo(e.target.value)} />
            <button className="primary" onClick={() => { onAdd(from, to, note, project); setAdding(false) }}>Hinzufügen</button>
            <button onClick={() => setAdding(false)}>×</button>
          </div>
        : <button className="add" onClick={() => setAdding(true)}>+ Zeit hinzufügen</button>}

      <div className="actions"><span style={{ flex: 1 }} /><button onClick={onCancel}>Schließen</button><button className="primary" onClick={() => onRename(ticket, note, project)}>Sichern</button></div>
    </Modal>
  )
}

// ---- Ticket auf Zeitraum buchen (Von–Bis, mehrfach pro Tag möglich) ----
function RangeAssign({ projects, defFrom, defTo, onSave, onCancel }: {
  projects: Project[]; defFrom: string; defTo: string
  onSave: (ticket: string, note: string, project: string, from: string, to: string) => void; onCancel: () => void
}) {
  const [ticket, setTicket] = useState('')
  const [note, setNote] = useState('')
  const [project, setProject] = useState('')
  const [from, setFrom] = useState(defFrom)
  const [to, setTo] = useState(defTo)
  return (
    <Modal title="Ticket auf Zeitraum buchen" onCancel={onCancel}>
      <label>Ticket / Titel <input autoFocus value={ticket} onChange={e => setTicket(e.target.value)} placeholder="z. B. WCMS-2607" /></label>
      {projects.length > 0 && <label>Projekt / Kunde (Farbe)
        <select value={project} onChange={e => setProject(e.target.value)}>
          <option value="">– keins –</option>
          {projects.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
        </select></label>}
      <div className="grid2"><label>Von <input type="time" value={from} onChange={e => setFrom(e.target.value)} /></label><label>Bis <input type="time" value={to} onChange={e => setTo(e.target.value)} /></label></div>
      <label>Beschreibung <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} /></label>
      <p className="hint">Pausen im Zeitraum bleiben Pausen (werden abgezogen). Mehrfach buchbar – z. B. erst 11:00–12:30, später 13:00–13:30 für dasselbe Ticket.</p>
      <div className="actions"><span style={{ flex: 1 }} /><button onClick={onCancel}>Abbrechen</button><button className="primary" onClick={() => onSave(ticket, note, project, from, to)}>Buchen</button></div>
    </Modal>
  )
}

function Modal({ title, onCancel, children }: { title: string; onCancel: () => void; children: any }) {
  return (
    <div className="modal-bg" onClick={onCancel}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <h2>{title}</h2>{children}
      </div>
    </div>
  )
}

// ---- Überstunden ----
function OvertimeView() {
  const [data, setData] = useState<OvertimeResult | null>(null)
  useEffect(() => { window.wt.overtime().then(setData) }, [])
  if (!data) return <div className="view pad">lädt…</div>
  const balCls = data.balanceHours >= 0 ? 'pos' : 'neg'
  return (
    <div className="view pad scroll">
      <div className="ot-balance">
        <span>Überstunden-Saldo</span>
        <b className={balCls}>{hmSigned(data.balanceHours)}</b>
      </div>
      <table className="ot-table">
        <thead><tr><th>Tag</th><th>Gearbeitet</th><th>Ziel</th><th>Saldo</th></tr></thead>
        <tbody>
          {[...data.days].reverse().map(d => (
            <tr key={d.date} className={d.isWorkday ? '' : 'weekend'}>
              <td>{new Date(d.date).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}</td>
              <td>{hm(d.workedHours * 3600)}</td>
              <td>{d.targetHours > 0 ? `${d.targetHours}h` : '–'}</td>
              <td className={d.deltaHours >= 0 ? 'pos' : 'neg'}>{hmSigned(d.deltaHours)}</td>
            </tr>
          ))}
          {data.days.length === 0 && <tr><td colSpan={4}>noch keine Daten</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

// ---- Einstellungen ----
const WEEKDAYS = [['So', 1], ['Mo', 2], ['Di', 3], ['Mi', 4], ['Do', 5], ['Fr', 6], ['Sa', 7]] as const

const SETTINGS_TABS: Array<[string, string, string]> = [
  ['projects', 'Projekte', 'folder'], ['capture', 'Erfassung', 'activity'], ['meetings', 'Meetings', 'users'],
  ['ai', 'KI', 'sparkles'], ['overtime', 'Überstunden', 'scale'], ['display', 'Anzeige', 'monitor'],
  ['mqtt', 'MQTT', 'broadcast'], ['api', 'API', 'code'], ['backup', 'Backup', 'archive']
]

function SettingsView() {
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [version, setVersion] = useState('')
  const [saved, setSaved] = useState(false)
  const [tab, setTab] = useState('projects')
  useEffect(() => { window.wt.getConfig().then(setCfg); window.wt.appVersion().then(setVersion) }, [])
  if (!cfg) return <div className="view pad">lädt…</div>

  const set = <K extends keyof Cfg>(k: K, v: Cfg[K]) => setCfg({ ...cfg, [k]: v })
  const save = async () => { await window.wt.saveConfig(cfg); setSaved(true); setTimeout(() => setSaved(false), 1500) }

  const num = (k: keyof Cfg, label: string, min = 0, max = 999) => (
    <label className="row">{label}
      <input type="number" min={min} max={max} value={cfg[k] as number}
        onChange={e => set(k, Number(e.target.value) as any)} />
    </label>
  )
  const toggle = (k: keyof Cfg, label: string) => (
    <label className="row check"><input type="checkbox" checked={cfg[k] as boolean} onChange={e => set(k, e.target.checked as any)} /> {label}</label>
  )

  // Projekte
  const addProject = () => {
    const used = cfg.projects.map(p => p.color)
    const free = PROJECT_COLORS.filter(c => !used.includes(c))
    const pool = free.length ? free : PROJECT_COLORS
    const color = pool[Math.floor(Math.random() * pool.length)]
    set('projects', [...cfg.projects, { id: uuid(), name: '', repoPath: '', gitUserEmail: '', color }])
  }
  const updProject = (id: string, patch: Partial<Project>) => set('projects', cfg.projects.map(p => p.id === id ? { ...p, ...patch } : p))
  const delProject = (id: string) => set('projects', cfg.projects.filter(p => p.id !== id))

  return (
    <div className="view settings">
      <div className="settings-body">
        <div className="settings-nav">
          {SETTINGS_TABS.map(([k, l, ic]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}><Icon name={ic} size={15} /> {l}</button>
          ))}
        </div>
        <div className="settings-pane scroll">
          {tab === 'projects' && (
            <section>
              <h3>Projekte</h3>
              <p className="hint">Jedes Projekt bekommt eine Farbe – Tickets erscheinen im Kalender in dieser Farbe.</p>
              {cfg.projects.map(p => <ProjectRow key={p.id} p={p} onChange={patch => updProject(p.id, patch)} onDelete={() => delProject(p.id)} />)}
              <button className="add" onClick={addProject}>+ Projekt</button>
            </section>
          )}

          {tab === 'capture' && (
            <section>
              <h3>Erfassung</h3>
              {num('idleThresholdMinutes', 'Inaktiv ab (Minuten)')}
              {num('breakCapMinutes', 'Pausen-Limit/Tag (Minuten)')}
              {num('roundingMinutes', 'Buchungsrundung (Minuten)')}
              <label className="row">Frage-Modus
                <select value={cfg.promptMode} onChange={e => set('promptMode', e.target.value as any)}>
                  <option value="off">aus</option>
                  <option value="onceADay">einmal täglich</option>
                  <option value="afterBreaks">nach Pausen</option>
                  <option value="everyUnlock">bei jedem Entsperren</option>
                </select>
              </label>
              {cfg.promptMode === 'afterBreaks' && num('promptAfterBreakMinutes', 'Pause-Schwelle (Minuten)')}
              {toggle('endDayOnSleep', 'Feierabend bei Zuklappen/Standby')}
              {toggle('launchAtLogin', 'Beim Anmelden automatisch starten')}
            </section>
          )}

          {tab === 'meetings' && (
            <section>
              <h3>Meetings</h3>
              {toggle('detectTeamsApi', 'Teams-Meetings automatisch erkennen')}
              {toggle('askMeetingTitle', 'Nach spontanem Call nach Titel fragen')}
              {cfg.detectTeamsApi && <p className="hint">Teams → Einstellungen → Datenschutz → Drittanbieter-API aktivieren.</p>}
            </section>
          )}

          {tab === 'ai' && <AiSection ai={cfg.ai} onChange={a => set('ai', a)} />}

          {tab === 'overtime' && (
            <section>
              <h3>Überstunden</h3>
              {num('targetHoursPerDay', 'Soll-Stunden/Tag', 0, 24)}
              {num('overtimeStartBalanceHours', 'Startsaldo (Stunden)', -9999, 9999)}
              <div className="row">Arbeitstage
                <div className="weekdays">
                  {WEEKDAYS.map(([lbl, n]) => (
                    <button key={n} className={cfg.workdayWeekdays.includes(n) ? 'on' : ''}
                      onClick={() => set('workdayWeekdays', cfg.workdayWeekdays.includes(n)
                        ? cfg.workdayWeekdays.filter(x => x !== n) : [...cfg.workdayWeekdays, n].sort())}>{lbl}</button>
                  ))}
                </div>
              </div>
            </section>
          )}

          {tab === 'display' && (
            <section>
              <h3>Anzeige</h3>
              {num('workdayStartHour', 'Kalender Start (Stunde)', 0, 23)}
              {num('workdayEndHour', 'Kalender Ende (Stunde)', 1, 24)}
            </section>
          )}

          {tab === 'mqtt' && <MqttSection mqtt={cfg.mqtt} onChange={m => set('mqtt', m)} />}

          {tab === 'api' && <ApiSection api={cfg.apiServer} onChange={a => set('apiServer', a)} />}

          {tab === 'backup' && <BackupSection backup={cfg.backup} onChange={b => set('backup', b)} />}
        </div>
      </div>

      <div className="settings-foot">
        <span className="ver">Version {version} · <a href="#" onClick={e => { e.preventDefault(); window.wt.checkUpdate() }}>nach Update suchen</a></span>
        <span className="spacer" />
        {saved && <span className="ok">gespeichert ✓</span>}
        <button className="primary" onClick={save}>Speichern</button>
      </div>
    </div>
  )
}

const MQTT_FIELDS: Array<[keyof MqttPublishFlags, string]> = [
  ['status', 'Status (Arbeit/Pause/Feierabend)'],
  ['inCall', 'Im Call'],
  ['callTitle', 'Call-Titel'],
  ['workedToday', 'Gearbeitet heute'],
  ['breakToday', 'Pause heute'],
  ['overtimeBalance', 'Überstunden-Saldo'],
  ['workedWeek', 'Gearbeitet diese Woche'],
  ['currentTicket', 'Aktuelles Ticket']
]

function MqttSection({ mqtt, onChange }: { mqtt: MqttConfig; onChange: (m: MqttConfig) => void }) {
  const [test, setTest] = useState<string>('')
  const set = <K extends keyof MqttConfig>(k: K, v: MqttConfig[K]) => onChange({ ...mqtt, [k]: v })
  const setFlag = (k: keyof MqttPublishFlags, v: boolean) => onChange({ ...mqtt, publish: { ...mqtt.publish, [k]: v } })
  const doTest = async () => {
    setTest('teste…')
    const r = await window.wt.mqttTest(mqtt)
    setTest(r.ok ? '✓ Verbindung erfolgreich' : `✕ ${r.error || 'Fehler'}`)
  }
  return (
    <section>
      <h3>MQTT</h3>
      <p className="hint">Sendet Status/Zeiten an einen beliebigen MQTT-Broker. Optional mit Home-Assistant-Discovery (legt Entities automatisch an).</p>
      <label className="row check"><input type="checkbox" checked={mqtt.enabled} onChange={e => set('enabled', e.target.checked)} /> MQTT aktivieren</label>
      {mqtt.enabled && <>
        <div className="row">Broker
          <span style={{ display: 'flex', gap: 6 }}>
            <input style={{ width: 180 }} placeholder="192.168.2.x" value={mqtt.host} onChange={e => set('host', e.target.value)} />
            <input type="number" style={{ width: 80 }} value={mqtt.port} onChange={e => set('port', Number(e.target.value))} />
          </span>
        </div>
        <label className="row">Benutzer<input value={mqtt.username} onChange={e => set('username', e.target.value)} /></label>
        <label className="row">Passwort<input type="password" value={mqtt.password} onChange={e => set('password', e.target.value)} /></label>
        <label className="row">Topic-Präfix<input value={mqtt.baseTopic} onChange={e => set('baseTopic', e.target.value)} /></label>
        <label className="row check"><input type="checkbox" checked={mqtt.retain} onChange={e => set('retain', e.target.checked)} /> Werte „retained" senden</label>
        <label className="row check"><input type="checkbox" checked={mqtt.haDiscovery} onChange={e => set('haDiscovery', e.target.checked)} /> Home-Assistant-Discovery (Entities automatisch anlegen)</label>

        <div className="mqtt-fields">
          <span className="lbl">Senden:</span>
          {MQTT_FIELDS.map(([k, lbl]) => (
            <label key={k} className="chk"><input type="checkbox" checked={mqtt.publish[k]} onChange={e => setFlag(k, e.target.checked)} /> {lbl}</label>
          ))}
        </div>

        <div className="row" style={{ justifyContent: 'flex-start', gap: 10 }}>
          <button className="add" onClick={doTest}>Verbindung testen</button>
          <span className="hint" style={{ margin: 0 }}>{test}</span>
        </div>
        <p className="hint">Topics unter <code>{mqtt.baseTopic || 'worktracker'}/…</code> (z. B. <code>/status</code>, <code>/worked_today</code>). Discovery legt die Entities unter <code>homeassistant/…</code> an.</p>
      </>}
    </section>
  )
}

const AI_CUSTOM = '__custom__'

function AiSection({ ai, onChange }: { ai: AiConfig; onChange: (a: AiConfig) => void }) {
  const [test, setTest] = useState('')
  const [models, setModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState(false)
  const set = <K extends keyof AiConfig>(k: K, v: AiConfig[K]) => onChange({ ...ai, [k]: v })
  const setProvider = (p: AiProvider) => { setModels([]); onChange({ ...ai, provider: p, model: AI_DEFAULT_MODEL[p] }) }
  const doTest = async () => { setTest('teste…'); const r = await window.wt.aiTest(ai); setTest(r.ok ? '✓ Verbindung erfolgreich' : `✕ ${r.error || 'Fehler'}`) }
  const loadModels = async () => {
    setLoadingModels(true); setTest('')
    const r = await window.wt.aiModels(ai)
    setLoadingModels(false)
    if (r.error) setTest(`✕ ${r.error}`)
    else { setModels(r.models); if (r.models.length && !r.models.includes(ai.model)) set('model', r.models[0]) }
  }
  const list = Array.from(new Set([...AI_MODELS[ai.provider], ...models]))
  const isCustom = !list.includes(ai.model)
  return (
    <section>
      <h3>KI – Ticket-Zuordnung aus Commits</h3>
      <p className="hint">Ordnet Arbeitsblöcken anhand der Git-Commits des Tages automatisch Tickets + Kurzbeschreibung zu. Auslösen im Kalender über das ✨-Symbol.</p>
      <label className="row check"><input type="checkbox" checked={ai.enabled} onChange={e => set('enabled', e.target.checked)} /> KI aktivieren</label>
      {ai.enabled && <>
        <label className="row">Anbieter
          <select value={ai.provider} onChange={e => setProvider(e.target.value as AiProvider)}>
            <option value="gemini">Google Gemini</option>
            <option value="openai">OpenAI</option>
            <option value="minimax">MiniMax</option>
          </select>
        </label>
        <label className="row">API-Key <input type="password" value={ai.apiKey} onChange={e => set('apiKey', e.target.value)} placeholder="hier einfügen" /></label>
        <p className="hint">Key holen: <a href="#" onClick={e => { e.preventDefault(); window.wt.openExternal(AI_KEY_URL[ai.provider]) }}>{AI_PROVIDER_LABEL[ai.provider]} →</a></p>
        <label className="row">Modell
          <span style={{ display: 'flex', gap: 6 }}>
            <select value={isCustom ? AI_CUSTOM : ai.model} onChange={e => set('model', e.target.value === AI_CUSTOM ? '' : e.target.value)}>
              {list.map(m => <option key={m} value={m}>{m}</option>)}
              <option value={AI_CUSTOM}>eigenes…</option>
            </select>
            <button className="add" onClick={loadModels} disabled={loadingModels || !ai.apiKey} title="Live verfügbare Modelle des Anbieters laden">{loadingModels ? '…' : '↻'}</button>
          </span>
        </label>
        {isCustom && <label className="row">Modellname <input value={ai.model} onChange={e => set('model', e.target.value)} placeholder="eigenes Modell" /></label>}
        <div className="row" style={{ justifyContent: 'flex-start', gap: 10 }}>
          <button className="add" onClick={doTest}>Verbindung testen</button>
          <span className="hint" style={{ margin: 0 }}>{test}</span>
        </div>
      </>}
    </section>
  )
}

function BackupSection({ backup, onChange }: { backup: BackupConfig; onChange: (b: BackupConfig) => void }) {
  const [msg, setMsg] = useState('')
  const set = <K extends keyof BackupConfig>(k: K, v: BackupConfig[K]) => onChange({ ...backup, [k]: v })
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 4500) }
  const doExport = async () => { const r = await window.wt.exportBackup(); if (r.ok) flash('✓ Exportiert: ' + (r.file || '')); else if (r.error) flash('✕ ' + r.error) }
  const doImport = async () => { const r = await window.wt.importBackup(); if (r.ok) { setMsg('✓ Importiert – lade neu…'); setTimeout(() => location.reload(), 800) } else if (r.error) flash('✕ ' + r.error) }
  const pick = async () => { const dir = await window.wt.pickFolder(); if (dir) set('folder', dir) }
  const backupNow = async () => { const r = await window.wt.backupNow(); flash(r.ok ? '✓ Gesichert: ' + r.file : '✕ ' + (r.error || 'kein Ordner')) }
  return (
    <section>
      <h3>Backup & Wiederherstellung</h3>
      <p className="hint">Sichert Zeiten, Tickets, Tagesbearbeitungen und Einstellungen in eine Datei – für den Umzug auf einen neuen Rechner oder zur Sicherheit.</p>
      <div className="row" style={{ justifyContent: 'flex-start', gap: 10 }}>
        <button className="add" onClick={doExport}>Jetzt exportieren…</button>
        <button className="add" onClick={doImport}>Importieren…</button>
      </div>

      <h3 style={{ marginTop: 20 }}>Automatische Backups</h3>
      <label className="row check"><input type="checkbox" checked={backup.auto} onChange={e => set('auto', e.target.checked)} /> Automatisch sichern</label>
      {backup.auto && <>
        <label className="row">Intervall (Stunden) <input type="number" min={1} value={backup.intervalHours} onChange={e => set('intervalHours', Number(e.target.value))} /></label>
        <label className="row">Sicherungen behalten <input type="number" min={1} value={backup.keep} onChange={e => set('keep', Number(e.target.value))} /></label>
        <div className="row">Zielordner
          <span style={{ display: 'flex', gap: 6, flex: 1 }}>
            <input style={{ flex: 1 }} readOnly value={backup.folder} placeholder="– kein Ordner gewählt –" />
            <button className="add" onClick={pick}>Ordner…</button>
          </span>
        </div>
        <div className="row" style={{ justifyContent: 'flex-start' }}>
          <button className="add" onClick={backupNow} disabled={!backup.folder}>Jetzt sichern</button>
        </div>
        <p className="hint">Nach „Speichern" greift das Intervall. Es werden die letzten {backup.keep} Sicherungen behalten, ältere automatisch gelöscht.</p>
      </>}
      {msg && <p className="hint" style={{ color: msg.startsWith('✓') ? 'var(--pos)' : 'var(--neg)' }}>{msg}</p>}
    </section>
  )
}

function ApiSection({ api, onChange }: { api: ApiServerConfig; onChange: (a: ApiServerConfig) => void }) {
  const [copied, setCopied] = useState('')
  const set = <K extends keyof ApiServerConfig>(k: K, v: ApiServerConfig[K]) => onChange({ ...api, [k]: v })
  const genToken = () => set('token', (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, ''))
  const copy = (text: string, what: string) => { navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 1500) }
  const base = `http://127.0.0.1:${api.port || 8787}`
  const example = `curl -X POST ${base}/api/assign \\
  -H "Authorization: Bearer ${api.token || '<TOKEN>'}" \\
  -H "Content-Type: application/json" \\
  -d '{"date":"2026-06-08","from":"14:00","to":"15:30","ticket":"Figma","project":"JUMO","note":"Hero Section"}'`
  return (
    <section>
      <h3>HTTP-API (Steuerung von außen)</h3>
      <p className="hint">Lokaler Endpunkt (nur 127.0.0.1, Token-geschützt). Damit können Einträge von außen gesetzt werden – z. B. bei Figma-Arbeit ohne Git-Commits.</p>
      <label className="row check"><input type="checkbox" checked={api.enabled} onChange={e => { if (e.target.checked && !api.token) genToken(); set('enabled', e.target.checked) }} /> API aktivieren</label>
      {api.enabled && <>
        <label className="row">Port <input type="number" value={api.port} onChange={e => set('port', Number(e.target.value))} /></label>
        <label className="row">Token
          <span style={{ display: 'flex', gap: 6, flex: 1 }}>
            <input style={{ flex: 1, fontFamily: 'monospace', fontSize: 11 }} readOnly value={api.token} />
            <button className="add" onClick={() => copy(api.token, 'token')}>{copied === 'token' ? '✓' : 'Kopieren'}</button>
            <button className="add" onClick={genToken}>Neu</button>
          </span>
        </label>
        <p className="hint">Nach Änderungen <b>Speichern</b>. Basis-URL: <code>{base}</code></p>
        <h3 style={{ marginTop: 18 }}>Beispiel</h3>
        <pre className="api-example">{example}</pre>
        <button className="add" onClick={() => copy(example, 'curl')}>{copied === 'curl' ? 'Kopiert ✓' : 'Beispiel kopieren'}</button>
        <p className="hint" style={{ marginTop: 12 }}>Routen: <code>GET /api/day?date=</code>, <code>POST /api/assign</code>, <code>POST /api/day</code>, <code>POST /api/reset</code>, <code>GET /api/projects</code>.</p>
      </>}
    </section>
  )
}

function ProjectRow({ p, onChange, onDelete }: { p: Project; onChange: (patch: Partial<Project>) => void; onDelete: () => void }) {
  const [emails, setEmails] = useState<string[]>([])
  useEffect(() => { if (p.repoPath) window.wt.gitEmails(p.repoPath).then(setEmails) }, [p.repoPath])
  const pick = async () => {
    const dir = await window.wt.pickFolder()
    if (dir) { onChange({ repoPath: dir, name: p.name || dir.split('/').pop() || dir }); const es = await window.wt.gitEmails(dir); setEmails(es); if (es.length && !p.gitUserEmail) onChange({ gitUserEmail: es[0] }) }
  }
  const opts = p.gitUserEmail && !emails.includes(p.gitUserEmail) ? [p.gitUserEmail, ...emails] : emails
  return (
    <div className="project">
      <div className="prow">
        <input type="color" className="pcolor" title="Projektfarbe" value={p.color || '#34c759'} onChange={e => onChange({ color: e.target.value })} />
        <input className="pname" placeholder="Projektname" value={p.name} onChange={e => onChange({ name: e.target.value })} />
      </div>
      <div className="prow">
        <input className="ppath" placeholder="Repo-Pfad" value={p.repoPath} onChange={e => onChange({ repoPath: e.target.value })} />
        <button onClick={pick}>📁</button>
      </div>
      <div className="prow">
        <select className="pemail" value={p.gitUserEmail} onChange={e => onChange({ gitUserEmail: e.target.value })}>
          <option value="">– Git-User wählen –</option>
          {opts.map(em => <option key={em} value={em}>{em}</option>)}
        </select>
        <button className="danger" onClick={onDelete}>✕</button>
      </div>
    </div>
  )
}
