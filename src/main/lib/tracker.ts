// Laufzeit-Kern: aktiv/inaktiv aus Idle + Lock + Sleep (powerMonitor,
// cross-platform). Schreibt .active/.inactive/.sample-Events.

import { powerMonitor } from 'electron'
import { EventEmitter } from 'node:events'
import { AppConfig, WTEvent } from './types'
import { appendEvent } from './store'
import { summary } from './day'
import { activeProject } from './git'

export type Status = 'active' | 'paused' | 'off'

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
  private manualOff = false        // Feierabend gesetzt
  private manualPause = false      // manuelle Pause (hält gegen Idle-Reaktivierung)
  private offDayKey = ''           // an welchem Tag Feierabend gilt
  private lastActivationTs = 0     // letzter active-Zeitpunkt (für Rückgängig via Popup)
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
    if (this.manualOff) return 'Feierabend'
    if (this.status === 'paused') return 'Pause'
    return 'Bereit'
  }

  start() {
    this.log({ ts: Date.now(), type: 'appStart', reason: 'launch' })

    powerMonitor.on('lock-screen', () => this.setLocked(true))
    powerMonitor.on('unlock-screen', () => this.setLocked(false))
    powerMonitor.on('suspend', () => {
      // Zuklappen/Standby: optional sofort Feierabend, sonst wie Lock (Pause).
      if (this.config.endDayOnSleep) this.feierabend('sleep')
      else this.setLocked(true)
    })
    powerMonitor.on('resume', () => this.setLocked(false))

    this.evalTimer = setInterval(() => { this.evaluate('tick'); this.emit('update') }, 20_000)
    this.sampleTimer = setInterval(() => this.sample(), Math.max(15, this.config.sampleIntervalSeconds) * 1000)

    this.evaluate('launch')
    this.emit('update')
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
    // Beim Sperren den manuellen Pause-Hold lösen -> nächstes Entsperren fragt neu.
    if (v) this.manualPause = false
    // Beim Entsperren an einem neuen Tag den Feierabend-Status zurücksetzen.
    if (!v && this.manualOff && this.dayKey() !== this.offDayKey) this.manualOff = false
    this.evaluate(v ? 'lock' : 'unlock')
    this.emit('update')
  }

  private dayKey(d = Date.now()) { return new Date(d).toLocaleDateString('sv-SE') }

  /** Feierabend: Tag beenden, bis zum nächsten Tag oder „Arbeit fortsetzen". */
  feierabend(reason = 'feierabend') {
    this.manualOff = true
    this.offDayKey = this.dayKey()
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
    this.manualOff = true
    this.offDayKey = this.dayKey()
    this.currentlyActive = false
    this.status = 'off'
  }

  /** Manuell „Arbeit fortsetzen" – hebt Feierabend/Pause-Override auf. */
  resumeWork() {
    this.manualOff = false
    this.manualPause = false
    this.currentlyActive = false  // erzwingt frisches active-Event in evaluate
    this.evaluate('manual')
    this.emit('update')
  }

  /** Manuell Pause setzen (hält gegen Idle-Reaktivierung bis „Arbeiten"). */
  pauseWork() {
    this.manualPause = true
    if (this.currentlyActive) {
      this.currentlyActive = false
      this.log({ ts: Date.now(), type: 'inactive', reason: 'manual' })
      this.stateSince = Date.now()
    }
    this.status = 'paused'
    this.emit('update')
  }

  /** Popup-Antwort „Pause/Privat": gerade gestartetes Arbeiten rückgängig machen
   *  (kein Arbeitsintervall) und Pause halten, bis „Arbeiten" geklickt wird. */
  revertActivation() {
    this.manualPause = true
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
    // Feierabend endet automatisch beim Tageswechsel – sonst bliebe der
    // gestrige Feierabend heute aktiv und es würde nicht erfasst/gefragt.
    if (this.manualOff && this.dayKey() !== this.offDayKey) this.manualOff = false

    const threshold = Math.max(1, this.config.idleThresholdMinutes) * 60
    const idle = this.idleSeconds()
    const desired = !this.manualOff && !this.manualPause && !this.screenLocked && (idle < threshold || this.inCall)

    if (desired === this.currentlyActive) {
      this.status = this.currentlyActive ? 'active' : (this.status === 'off' ? 'off' : 'paused')
      return
    }
    if (!desired) {
      this.currentlyActive = false
      const ts = reason === 'tick' ? Date.now() - idle * 1000 : Date.now()
      this.log({ ts, type: 'inactive', reason })
      this.status = 'paused'
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
