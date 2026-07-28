// Gemeinsame Datentypen (portiert aus der Swift-Version).

export type EventType =
  | 'appStart' | 'appStop'
  | 'active' | 'inactive'
  | 'lock' | 'unlock' | 'sleep' | 'wake'
  | 'sample'

export interface WTEvent {
  ts: number // epoch ms
  type: EventType
  reason?: string
  app?: string
  repo?: string
  branch?: string
  ticket?: string
  call?: string // Meeting-Label (Teams/Kalender), falls Call läuft
}

export type SegmentKind = 'work' | 'break'
export type SegmentSource = 'auto' | 'manual'

export interface Segment {
  id: string
  start: number // epoch ms
  end: number
  kind: SegmentKind
  ticket?: string | null
  note?: string | null
  project?: string | null // Projektname -> bestimmt die Farbe
  meeting?: boolean        // aus einem Call abgeleitet -> lila
  source: SegmentSource
}

/** Abwesenheits-Typen. krank/urlaub: Soll wird gewaivt -> kein Minus.
 *  fza (Freizeitausgleich): Soll wird aus dem Überstundenkonto bezahlt -> Minus. */
export type AbsenceType = 'krank' | 'urlaub' | 'fza'

export interface DaySummary {
  date: number
  start?: number
  end?: number
  workedSeconds: number
  breakSeconds: number
  segments: Segment[]
  materialized: boolean
  absence?: AbsenceType | null
}

export type PromptMode = 'off' | 'onceADay' | 'afterBreaks' | 'everyUnlock'

export interface AppConfig {
  idleThresholdMinutes: number
  sampleIntervalSeconds: number
  breakCapMinutes: number
  workdayStartHour: number
  workdayEndHour: number
  roundingMinutes: number
  promptMode: PromptMode
  promptAfterBreakMinutes: number
  endDayOnSleep: boolean
  detectTeamsApi: boolean
  askMeetingTitle: boolean
  launchAtLogin: boolean
  // Mitarbeiter-/Nutzername (erscheint im Monatsbericht + Dateiname)
  employeeName: string
  // Überstunden
  targetHoursPerDay: number
  workdayWeekdays: number[] // 1=So..7=Sa
  overtimeStartBalanceHours: number
  dailyLimitHours: number // Warn-Popup bei erreichter Tagesgrenze (ArbZG 10h); 0 = aus
  // Projekte
  projects: Project[]
  // MQTT
  mqtt: MqttConfig
  // KI (Commit-Analyse / Ticket-Zuordnung)
  ai: AiConfig
  // Lokaler HTTP-API-Endpunkt (Steuerung von außen)
  apiServer: ApiServerConfig
  // Backup (Export/Import + automatisch)
  backup: BackupConfig
  // Monatsbericht (automatisch bei Monatswechsel)
  report: ReportConfig
}

export interface BackupConfig {
  auto: boolean
  onFeierabend: boolean   // Backup beim Feierabend (Tag abgeschlossen)
  onNewDay: boolean       // Backup beim ersten Arbeitsstart eines neuen Tages
  intervalHours: number   // zusätzlich zeitbasiert mit Nachhol-Logik (0 = aus)
  folder: string
  keep: number
  lastBackupTs?: number   // intern: Zeitpunkt des letzten Auto-Backups
}

export function defaultBackupConfig(): BackupConfig {
  return { auto: false, onFeierabend: true, onNewDay: true, intervalHours: 24, folder: '', keep: 14 }
}

export interface ReportConfig {
  monthly: boolean   // Monatsbericht bei Monatswechsel automatisch erstellen
  folder: string     // Zielordner (leer = userData/reports)
  lastMonth: string  // intern: YYYY-MM des zuletzt erzeugten Berichts
}

export function defaultReportConfig(): ReportConfig {
  return { monthly: true, folder: '', lastMonth: '' }
}

export interface ApiServerConfig {
  enabled: boolean
  port: number
  token: string
}

export function defaultApiServerConfig(): ApiServerConfig {
  return { enabled: false, port: 8787, token: '' }
}

export type AiProvider = 'gemini' | 'openai' | 'minimax'

export interface AiConfig {
  enabled: boolean
  provider: AiProvider
  apiKey: string
  model: string
}

export const AI_DEFAULT_MODEL: Record<AiProvider, string> = {
  gemini: 'gemini-2.5-flash',
  openai: 'gpt-4o-mini',
  minimax: 'MiniMax-Text-01'
}

export const AI_KEY_URL: Record<AiProvider, string> = {
  gemini: 'https://aistudio.google.com/app/apikey',
  openai: 'https://platform.openai.com/api-keys',
  minimax: 'https://www.minimax.io/platform'
}

export function defaultAiConfig(): AiConfig {
  return { enabled: false, provider: 'gemini', apiKey: '', model: AI_DEFAULT_MODEL.gemini }
}

export interface MqttPublishFlags {
  status: boolean
  inCall: boolean
  workedToday: boolean
  breakToday: boolean
  overtimeBalance: boolean
  workedWeek: boolean
  currentTicket: boolean
}

export interface MqttConfig {
  enabled: boolean
  host: string
  port: number
  username: string
  password: string
  baseTopic: string      // z. B. "worktracker"
  retain: boolean
  haDiscovery: boolean   // Home-Assistant-MQTT-Discovery-Configs senden
  publish: MqttPublishFlags
}

export interface Project {
  id: string
  name: string
  repoPath: string
  gitUserEmail: string
  color: string // Hex, z. B. "#34c759"
  internal?: boolean // interne (nicht abrechenbare) Arbeit – eigene Kategorie im Bericht
}

/** Farbpalette für neue Projekte (macOS-Systemfarben). */
export const PROJECT_COLORS = [
  '#34c759', '#ff9500', '#ff2d55', '#5ac8fa', '#af52de',
  '#ffcc00', '#00c7be', '#ff3b30', '#a2845e', '#30b0c7'
]

export const UNASSIGNED = 'Nicht zugewiesen'

export function defaultConfig(): AppConfig {
  return {
    idleThresholdMinutes: 15,
    sampleIntervalSeconds: 60,
    breakCapMinutes: 30,
    workdayStartHour: 6,
    workdayEndHour: 20,
    roundingMinutes: 15,
    promptMode: 'afterBreaks',
    promptAfterBreakMinutes: 20,
    endDayOnSleep: true,
    detectTeamsApi: false,
    askMeetingTitle: true,
    launchAtLogin: true,
    employeeName: '',
    targetHoursPerDay: 8,
    workdayWeekdays: [2, 3, 4, 5, 6],
    overtimeStartBalanceHours: 0,
    dailyLimitHours: 10,
    projects: [],
    mqtt: defaultMqttConfig(),
    ai: defaultAiConfig(),
    apiServer: defaultApiServerConfig(),
    backup: defaultBackupConfig(),
    report: defaultReportConfig()
  }
}

export function defaultMqttConfig(): MqttConfig {
  return {
    enabled: false,
    host: '',
    port: 1883,
    username: '',
    password: '',
    baseTopic: 'worktracker',
    retain: true,
    haDiscovery: true,
    publish: {
      status: true,
      inCall: true,
      workedToday: true,
      breakToday: false,
      overtimeBalance: true,
      workedWeek: true,
      currentTicket: false
    }
  }
}
