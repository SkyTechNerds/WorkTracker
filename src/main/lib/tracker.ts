// Laufzeit-Kern: aktiv/inaktiv aus Idle + Lock + Sleep (powerMonitor,
// cross-platform). Schreibt .active/.inactive/.sample-Events.

import { powerMonitor } from 'electron'
import { EventEmitter } from 'node:events'
import { AppConfig, WTEvent } from './types'
import { appendEvent } from './store'
import { summary } from './day'
import { activeProject } from './git'

export type Status = 'active' | 'paused' | 'off'

/** Ein 'suspend' innerhalb dieser Spanne nach dem Aufwachen/Entsperren gilt als
 *  Geister-Event (macOS-Wake-Sequenz) und wird ignoriert. */
const WAKE_SUSPEND_GRACE_MS = 15_000

export class Tracker extends EventEmitter {
  private config: AppConfig
  status: Status = 'off'
  stateSince = Date.now()
  inCall = false
  callLabel: string | null = null
  currentTicket: string | null = null
  currentRepo: string | null = null

  private screenLocked = false
  private currentlyActive = false
  // Session-Modell: Erfassung läuft NUR, wenn eine Arbeitssitzung explizit gestartet
  // wurde ("Arbeit"/resumeWork). Sie wird durch "Pause"/"Privat"/"Feierabend" beendet
  // und überlebt KEINEN Tageswechsel — d. h. nichts wird automatisch (Idle/Unlock/Tick)
  // mitgezählt, solange keine Sitzung läuft (kein Nacht-/Wochenend-Mitzählen).
  private working = false                                  // läuft eine Arbeitssitzung?
  private stoppedReason: 'pause' | 'feierabend' | null = null  // warum gerade keine (für Anzeige)
  private sessionDayKey = ''                               // Tag, an dem die Sitzung gestartet wurde
  private lastActivationTs = 0     // letzter active-Zeitpunkt (für Rückgängig via Popup)
  private lastWakeTs = 0           // letztes Entsperren/Aufwachen (gegen Sleep-Geister-Events)
  private evalTimer?: NodeJS.Timeout
  private sampleTimer?: NodeJS.Timeout
  private graceSeconds: number

  constructor(config: AppConfig) {
    super()
    this.config = config
    this.graceSeconds = Math.max(180, 2 * config.sampleIntervalSeconds)
  }

  setConfig(c: AppConfig) { this.config = c }

  /** Sprechendes Label für Anzeige/MQTT. */
  get displayStatus(): 'Arbeit' | 'Pause' | 'Feierabend' | 'Bereit' {
    if (this.status === 'active') return 'Arbeit'
    if (this.stoppedReason === 'feierabend') return 'Feierabend'
    if (this.working || this.stoppedReason === 'pause') return 'Pause'  // Sitzung läuft (Idle-Pause) ODER manuell pausiert
    return 'Bereit'  // keine Sitzung gestartet
  }

  /** Innerhalb des konfigurierten Arbeitszeit-Fensters (Wochentag + Stunden)?
   *  Steuert NUR, ob beim Entsperren proaktiv zum Start gefragt wird — nie das Zählen. */
  private withinWorkWindow(d = Date.now()): boolean {
    const date = new Date(d)
    const wd = date.getDay() + 1 // JS 0=So..6=Sa -> Config 1=So..7=Sa
    const days = this.config.workdayWeekdays?.length ? this.config.workdayWeekdays : [2, 3, 4, 5, 6]
    if (!days.includes(wd)) return false
    const h = date.getHours()
    return h >= (this.config.workdayStartHour ?? 0) && h < (this.config.workdayEndHour ?? 24)
  }

  start() {
    this.log({ ts: Date.now(), type: 'appStart', reason: 'launch' })

    powerMonitor.on('lock-screen', () => this.setLocked(true))
    powerMonitor.on('unlock-screen', () => { this.lastWakeTs = Date.now(); this.setLocked(false) })
    powerMonitor.on('suspend', () => {
      // macOS feuert beim Aufwachen manchmal ein verspätetes 'suspend' wenige Sekunden
      // NACH dem Entsperren/Resume — das ist kein echtes Zubettgehen. Solche Geister-
      // Events ignorieren, sonst löst es fälschlich Feierabend aus und stoppt die gerade
      // beim Login gestartete Arbeit (Popup-„Arbeit" lief dann ins Leere).
      if (Date.now() - this.lastWakeTs < WAKE_SUSPEND_GRACE_MS) return
      // Zuklappen/Standby: optional sofort Feierabend, sonst wie Lock (Pause).
      if (this.config.endDayOnSleep) this.feierabend('sleep')
      else this.setLocked(true)
    })
    powerMonitor.on('resume', () => { this.lastWakeTs = Date.now(); this.setLocked(false) })

    this.evalTimer = setInterval(() => { this.evaluate('tick'); this.emit('update') }, 20_000)
    this.sampleTimer = setInterval(() => this.sample(), Math.max(15, this.config.sampleIntervalSeconds) * 1000)

    this.evaluate('launch')
    this.emit('update')
    // Beim (Login-)Start in der Arbeitszeit zum Start auffordern, wenn keine Sitzung
    // läuft — beim Auto-Launch kommt nicht zwingend ein 'unlock'-Event.
    if (!this.working && !this.inCall && this.withinWorkWindow()) this.emit('promptStart')
  }

  stop() {
    if (this.currentlyActive) this.log({ ts: Date.now(), type: 'inactive', reason: 'quit' })
    this.log({ ts: Date.now(), type: 'appStop', reason: 'quit' })
    if (this.evalTimer) clearInterval(this.evalTimer)
    if (this.sampleTimer) clearInterval(this.sampleTimer)
  }

  /** Teams/Meeting-Status von außen setzen (TeamsClient). */
  setMeeting(label: string | null) {
    this.callLabel = label
    this.inCall = label !== null
    this.evaluate('teams')
    this.emit('update')
  }

  private setLocked(v: boolean) {
    if (this.screenLocked === v) return
    this.screenLocked = v
    this.log({ ts: Date.now(), type: v ? 'lock' : 'unlock' })
    this.evaluate(v ? 'lock' : 'unlock')
    this.emit('update')
    // Beim Entsperren in der Arbeitszeit proaktiv zum Start auffordern, wenn keine
    // Sitzung läuft (Auto-Start gibt es nicht mehr). Außerhalb des Fensters / am
    // Wochenende KEIN Popup — dann bleibt es einfach privat/ungezählt.
    if (!v && !this.working && !this.inCall && this.withinWorkWindow()) this.emit('promptStart')
  }

  private dayKey(d = Date.now()) { return new Date(d).toLocaleDateString('sv-SE') }

  /** Feierabend: Arbeitssitzung beenden – nichts wird mehr erfasst, bis „Arbeit"
   *  wieder explizit gestartet wird (überlebt Tageswechsel/Standby/Neustart). */
  feierabend(reason = 'feierabend') {
    this.working = false
    this.stoppedReason = 'feierabend'
    this.sessionDayKey = ''
    if (this.currentlyActive) {
      this.currentlyActive = false
      this.log({ ts: Date.now(), type: 'inactive', reason })
      this.stateSince = Date.now()
    }
    this.status = 'off'
    this.emit('update')
  }

  /** Feierabend-Zustand beim Start wiederherstellen (kein Event, kein Tracking). */
  restoreFeierabend() {
    this.working = false
    this.stoppedReason = 'feierabend'
    this.sessionDayKey = ''
    this.currentlyActive = false
    this.status = 'off'
  }

  /** Manuell „Arbeit (fort)setzen" – startet eine Arbeitssitzung (das EINZIGE, was
   *  Erfassung anschaltet). Idle/Sperren innerhalb der Sitzung pausieren nur. */
  resumeWork() {
    this.working = true
    this.stoppedReason = null
    this.sessionDayKey = this.dayKey()
    this.currentlyActive = false  // erzwingt frisches active-Event in evaluate
    this.evaluate('manual')
    this.emit('update')
  }

  /** Manuell Pause: Sitzung anhalten – kein Mitzählen, bis „Arbeit" wieder klickt. */
  pauseWork() {
    this.working = false
    this.stoppedReason = 'pause'
    if (this.currentlyActive) {
      this.currentlyActive = false
      this.log({ ts: Date.now(), type: 'inactive', reason: 'manual' })
      this.stateSince = Date.now()
    }
    this.status = 'paused'
    this.emit('update')
  }

  /** Popup-Antwort „Pause/Privat": Sitzung NICHT starten (bzw. gerade gestartetes
   *  Arbeiten verwerfen) – es wird nichts erfasst, bis „Arbeit" geklickt wird. */
  revertActivation() {
    this.working = false
    this.stoppedReason = 'pause'
    this.currentlyActive = false
    if (this.lastActivationTs) this.log({ ts: this.lastActivationTs, type: 'inactive', reason: 'prompt-pause' })
    this.status = 'paused'
    this.stateSince = this.lastActivationTs || Date.now()
    this.emit('update')
  }

  private idleSeconds(): number {
    try { return powerMonitor.getSystemIdleTime() } catch { return 0 }
  }

  private evaluate(reason: string) {
    // Eine Arbeitssitzung überlebt KEINEN Tageswechsel – der neue Tag braucht einen
    // expliziten Start (sonst würde eine abends offen gebliebene Sitzung am nächsten
    // Morgen still weiterzählen).
    if (this.working && this.sessionDayKey && this.dayKey() !== this.sessionDayKey) {
      this.working = false
      this.stoppedReason = 'feierabend'
      this.sessionDayKey = ''
    }

    const threshold = Math.max(1, this.config.idleThresholdMinutes) * 60
    const idle = this.idleSeconds()
    // Beim Entsperren/Aufwachen ist der User definitiv präsent – die System-Idle-Zeit
    // ist da oft noch veraltet (zählt die Sperrzeit mit). Daher als anwesend werten.
    const present = idle < threshold || this.inCall || reason === 'unlock'
    // Erfassung NUR bei laufender Sitzung – Idle/Unlock/Tick startet nie von allein.
    const desired = this.working && !this.screenLocked && present

    if (desired === this.currentlyActive) {
      this.status = this.currentlyActive ? 'active' : (this.working || this.stoppedReason === 'pause' ? 'paused' : 'off')
      return
    }
    if (!desired) {
      this.currentlyActive = false
      const ts = reason === 'tick' ? Date.now() - idle * 1000 : Date.now()
      this.log({ ts, type: 'inactive', reason })
      this.status = this.working ? 'paused' : 'off'
      this.stateSince = ts
    } else {
      this.currentlyActive = true
      const ts = Date.now()
      const breakSeconds = Math.max(0, (ts - this.stateSince) / 1000)
      this.log({ ts, type: 'active', reason })
      this.status = 'active'
      this.stateSince = ts
      this.lastActivationTs = ts
      this.sample()
      this.emit('activated', { reason, breakSeconds })
    }
  }

  private sample() {
    if (!this.currentlyActive) return
    const proj = activeProject(this.config.projects)
    this.currentRepo = proj?.name ?? null
    this.currentTicket = proj?.ticket ?? null
    this.log({
      ts: Date.now(), type: 'sample',
      repo: proj?.name, branch: proj?.branch ?? undefined, ticket: proj?.ticket ?? undefined,
      call: this.config.detectTeamsApi ? (this.callLabel ?? undefined) : undefined
    })
  }

  private log(ev: WTEvent) { appendEvent(ev) }

  todaySummary() {
    return summary(Date.now(), Date.now(), this.graceSeconds)
  }

  daySummary(dateMs: number) {
    return summary(dateMs, Date.now(), this.graceSeconds)
  }
}
