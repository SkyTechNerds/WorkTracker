// MQTT-Publisher für Home Assistant. Sendet Arbeitsstatus, Call, Überstunden,
// Tages-/Wochenarbeitszeit – optional inkl. HA-MQTT-Discovery (Entities
// erscheinen automatisch in Home Assistant).

import mqtt, { MqttClient } from 'mqtt'
import { MqttConfig, MqttPublishFlags } from './types'

export interface WTSnapshot {
  status: string            // 'Arbeit' | 'Pause' | 'Feierabend' | 'Bereit'
  inCall: boolean
  workedTodayHours: number
  breakTodayMinutes: number
  overtimeHours: number
  workedWeekHours: number
  currentTicket: string
}

interface FieldDef {
  flag: keyof MqttPublishFlags
  topic: string             // relativ zum baseTopic
  component: 'sensor' | 'binary_sensor'
  name: string
  unit?: string
  deviceClass?: string
  icon: string
  value: (s: WTSnapshot) => string
}

const FIELDS: FieldDef[] = [
  { flag: 'status', topic: 'status', component: 'sensor', name: 'Status', icon: 'mdi:account-clock', value: s => s.status },
  { flag: 'inCall', topic: 'in_call', component: 'binary_sensor', name: 'Im Call', icon: 'mdi:phone-in-talk', value: s => (s.inCall ? 'ON' : 'OFF') },
  { flag: 'workedToday', topic: 'worked_today', component: 'sensor', name: 'Gearbeitet heute', unit: 'h', deviceClass: 'duration', icon: 'mdi:briefcase', value: s => s.workedTodayHours.toFixed(2) },
  { flag: 'breakToday', topic: 'break_today', component: 'sensor', name: 'Pause heute', unit: 'min', deviceClass: 'duration', icon: 'mdi:coffee', value: s => String(Math.round(s.breakTodayMinutes)) },
  { flag: 'overtimeBalance', topic: 'overtime', component: 'sensor', name: 'Überstunden-Saldo', unit: 'h', deviceClass: 'duration', icon: 'mdi:scale-balance', value: s => s.overtimeHours.toFixed(2) },
  { flag: 'workedWeek', topic: 'worked_week', component: 'sensor', name: 'Gearbeitet diese Woche', unit: 'h', deviceClass: 'duration', icon: 'mdi:calendar-week', value: s => s.workedWeekHours.toFixed(2) },
  { flag: 'currentTicket', topic: 'ticket', component: 'sensor', name: 'Aktuelles Ticket', icon: 'mdi:ticket-outline', value: s => s.currentTicket || '' }
]

const NODE = 'worktracker'

export class MqttPublisher {
  private client: MqttClient | null = null
  private cfg: MqttConfig | null = null
  private last: WTSnapshot | null = null
  private appVersion: string

  constructor(appVersion: string) { this.appVersion = appVersion }

  get connected() { return !!this.client?.connected }
  get statusText() {
    if (!this.cfg?.enabled) return 'aus'
    return this.client?.connected ? 'verbunden' : 'verbinde…'
  }

  private base() { return (this.cfg?.baseTopic || 'worktracker').replace(/\/+$/, '') }
  private availTopic() { return `${this.base()}/availability` }

  /** Config (neu) setzen – verbindet oder trennt je nach enabled/Änderung. */
  configure(cfg: MqttConfig) {
    const changed = JSON.stringify(cfg) !== JSON.stringify(this.cfg)
    this.cfg = cfg
    if (!cfg.enabled) { this.disconnect(); return }
    if (changed || !this.client) { this.reconnect() }
  }

  private reconnect() {
    this.disconnect()
    const cfg = this.cfg!
    if (!cfg.host) return
    const url = `mqtt://${cfg.host}:${cfg.port || 1883}`
    const client = mqtt.connect(url, {
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      reconnectPeriod: 30_000,
      connectTimeout: 10_000,
      clientId: `worktracker_${Math.floor(Date.now() % 1e6)}`,
      will: { topic: this.availTopic(), payload: 'offline', retain: true, qos: 0 }
    })
    this.client = client
    client.on('connect', () => {
      client.publish(this.availTopic(), 'online', { retain: true })
      this.sendDiscovery()
      if (this.last) this.publish(this.last)
    })
    client.on('error', () => { /* auto-reconnect übernimmt mqtt */ })
  }

  disconnect() {
    if (this.client) {
      try { this.client.publish(this.availTopic(), 'offline', { retain: true }) } catch { /* ignore */ }
      try { this.client.end(true) } catch { /* ignore */ }
    }
    this.client = null
  }

  /** Aktuellen Snapshot publizieren (nur aktivierte Felder). */
  publish(snap: WTSnapshot) {
    this.last = snap
    const c = this.client
    if (!c?.connected || !this.cfg) return
    const retain = this.cfg.retain
    for (const f of FIELDS) {
      if (!this.cfg.publish[f.flag]) continue
      c.publish(`${this.base()}/${f.topic}`, f.value(snap), { retain })
    }
  }

  /** HA-Discovery-Configs senden (aktivierte Felder) bzw. löschen (deaktivierte). */
  private sendDiscovery() {
    const c = this.client
    if (!c?.connected || !this.cfg) return
    const device = {
      identifiers: [NODE],
      name: 'WorkTracker',
      manufacturer: 'WorkTracker',
      model: 'Desktop',
      sw_version: this.appVersion
    }
    for (const f of FIELDS) {
      const cfgTopic = `homeassistant/${f.component}/${NODE}_${f.topic}/config`
      if (!this.cfg.haDiscovery || !this.cfg.publish[f.flag]) {
        c.publish(cfgTopic, '', { retain: true }) // Entity in HA entfernen
        continue
      }
      const payload: Record<string, unknown> = {
        name: f.name,
        unique_id: `${NODE}_${f.topic}`,
        object_id: `${NODE}_${f.topic}`,
        state_topic: `${this.base()}/${f.topic}`,
        availability_topic: this.availTopic(),
        icon: f.icon,
        device
      }
      if (f.unit) payload.unit_of_measurement = f.unit
      if (f.deviceClass) payload.device_class = f.deviceClass
      if (f.component === 'binary_sensor') { payload.payload_on = 'ON'; payload.payload_off = 'OFF' }
      c.publish(cfgTopic, JSON.stringify(payload), { retain: true })
    }
  }

  /** Einmaliger Verbindungstest – Promise<true> bei Connect, sonst Fehlertext. */
  test(cfg: MqttConfig): Promise<{ ok: boolean; error?: string }> {
    return new Promise(resolve => {
      if (!cfg.host) { resolve({ ok: false, error: 'Kein Host angegeben' }); return }
      const url = `mqtt://${cfg.host}:${cfg.port || 1883}`
      const c = mqtt.connect(url, {
        username: cfg.username || undefined,
        password: cfg.password || undefined,
        reconnectPeriod: 0,
        connectTimeout: 8_000,
        clientId: `worktracker_test_${Math.floor(Date.now() % 1e6)}`
      })
      let done = false
      const finish = (r: { ok: boolean; error?: string }) => { if (done) return; done = true; try { c.end(true) } catch { /* */ } resolve(r) }
      c.on('connect', () => finish({ ok: true }))
      c.on('error', (e) => finish({ ok: false, error: String((e as Error)?.message || e) }))
      setTimeout(() => finish({ ok: false, error: 'Timeout' }), 9_000)
    })
  }
}
