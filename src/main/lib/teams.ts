// Lokale Microsoft-Teams-API (WebSocket 127.0.0.1:8124) – liefert Meeting-Status.
// Cross-platform (Windows-Teams nutzt denselben Port).

import WebSocket from 'ws'
import { EventEmitter } from 'node:events'

export class TeamsClient extends EventEmitter {
  isInMeeting = false
  status = 'inaktiv'
  private ws?: WebSocket
  private enabled = false
  private reconnect?: NodeJS.Timeout
  private appVersion: string
  private failureCount = 0
  private notifiedUnreachable = false

  constructor(appVersion: string) { super(); this.appVersion = appVersion }

  start() {
    if (this.enabled) return
    this.enabled = true
    this.failureCount = 0
    this.notifiedUnreachable = false
    this.connect()
  }

  stop() {
    this.enabled = false
    if (this.reconnect) clearTimeout(this.reconnect)
    this.ws?.close()
    this.ws = undefined
    this.setMeeting(false)
    this.status = 'inaktiv'
  }

  private connect() {
    if (!this.enabled) return
    const params = new URLSearchParams({
      token: '',
      'protocol-version': '2.0.0',
      manufacturer: 'WorkTracker',
      device: 'Desktop',
      app: 'WorkTracker',
      'app-version': this.appVersion
    })
    this.status = 'verbinde…'
    const ws = new WebSocket(`ws://127.0.0.1:8124/?${params.toString()}`)
    this.ws = ws
    ws.on('message', (data) => this.handle(data.toString()))
    ws.on('error', () => this.scheduleReconnect())
    ws.on('close', () => this.scheduleReconnect())
  }

  private handle(s: string) {
    // Erfolgreiche Nachricht -> Verbindung steht.
    this.failureCount = 0
    this.notifiedUnreachable = false
    let obj: any
    try { obj = JSON.parse(s) } catch { return }
    const mu = obj.meetingUpdate
    if (mu) {
      const ms = mu.meetingState
      const mp = mu.meetingPermissions
      let inM = this.isInMeeting
      if (ms && typeof ms.isInMeeting === 'boolean') inM = ms.isInMeeting
      else if (mp) inM = !!mp.canLeave || !!mp.canToggleMute
      this.setMeeting(inM)
    }
  }

  private setMeeting(v: boolean) {
    if (v === this.isInMeeting) return
    this.isInMeeting = v
    this.status = v ? 'im Meeting' : 'verbunden'
    this.emit('change', v)
  }

  private scheduleReconnect() {
    this.setMeeting(false)
    this.ws = undefined
    if (!this.enabled) return
    this.status = 'Teams nicht erreichbar – neuer Versuch…'

    // Port zu trotz aktiviertem Erkennen -> meist Drittanbieter-API aus.
    this.failureCount++
    if (this.failureCount >= 2 && !this.notifiedUnreachable) {
      this.notifiedUnreachable = true
      this.status = 'Teams-API aus – in den Einstellungen aktivieren'
      this.emit('unreachable')
    }

    if (this.reconnect) clearTimeout(this.reconnect)
    this.reconnect = setTimeout(() => this.connect(), 30_000)
  }
}
