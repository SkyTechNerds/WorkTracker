// Lokaler HTTP-Steuer-Endpunkt (127.0.0.1, Token-geschützt). Erlaubt externen
// Werkzeugen (z. B. einem Agenten bei Figma-Arbeit ohne Git-Commits), Tage zu
// lesen und Einträge zu setzen.
//
// Routen (alle erfordern Header  Authorization: Bearer <token>  oder ?token=):
//   GET  /api/health
//   GET  /api/projects
//   GET  /api/day?date=YYYY-MM-DD
//   POST /api/assign   { date, from:"HH:MM", to:"HH:MM", kind?, ticket?, note?, project?, meeting? }  (to<=from = über Mitternacht)
//   POST /api/day      { date, segments:[{from|start, to|end, kind?, ticket?, note?, project?, meeting?}] }
//   POST /api/reset    { date }

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { AppConfig, Segment, ApiServerConfig } from './types'

export interface ApiContext {
  version: string
  getConfig: () => AppConfig
  deriveDay: (dateMs: number) => Segment[]
  saveDay: (dateMs: number, segs: Segment[]) => void
  resetDay: (dateMs: number) => void
  onChange: () => void
}

function dayMs(dateStr: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '')
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime()
}
function hhmmToMs(dateBase: number, hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '')
  if (!m) return null
  const d = new Date(dateBase); d.setHours(Number(m[1]), Number(m[2]), 0, 0)
  return d.getTime()
}
function clock(ms: number): string {
  const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function serializeDay(dateMs: number, segs: Segment[]) {
  return {
    date: new Date(dateMs).toLocaleDateString('sv-SE'),
    segments: segs.map(s => ({
      start: s.start, end: s.end, from: clock(s.start), to: clock(s.end),
      kind: s.kind, ticket: s.ticket ?? null, note: s.note ?? null,
      project: s.project ?? null, meeting: !!s.meeting
    }))
  }
}

/** Einen Zeitbereich aus allen Segmenten herausschneiden und neu belegen. */
function applyRange(segs: Segment[], a: number, b: number, attrs: Partial<Segment>): Segment[] {
  const out: Segment[] = []
  for (const s of segs) {
    if (s.end <= a || s.start >= b) { out.push(s); continue }
    if (s.start < a) out.push({ ...s, id: randomUUID(), end: a })
    if (s.end > b) out.push({ ...s, id: randomUUID(), start: b })
  }
  out.push({
    id: randomUUID(), start: a, end: b,
    kind: attrs.kind || 'work', ticket: attrs.ticket ?? null, note: attrs.note ?? null,
    project: attrs.project ?? null, meeting: !!attrs.meeting, source: 'manual'
  })
  return out.sort((x, y) => x.start - y.start)
}

export class ApiServer {
  private server: http.Server | null = null
  private cfg: ApiServerConfig | null = null
  private ctx: ApiContext

  constructor(ctx: ApiContext) { this.ctx = ctx }

  get running() { return !!this.server }
  get info() { return this.cfg?.enabled ? { port: this.cfg.port, running: this.running } : { running: false } }

  configure(cfg: ApiServerConfig) {
    const changed = JSON.stringify(cfg) !== JSON.stringify(this.cfg)
    this.cfg = cfg
    if (!cfg.enabled) { this.stop(); return }
    if (changed || !this.server) this.restart()
  }

  stop() {
    if (this.server) { try { this.server.close() } catch { /* */ } this.server = null }
  }

  private restart() {
    this.stop()
    const cfg = this.cfg!
    const server = http.createServer((req, res) => this.handle(req, res))
    server.on('error', () => { this.server = null })
    server.listen(cfg.port, '127.0.0.1')
    this.server = server
  }

  private send(res: http.ServerResponse, code: number, body: unknown) {
    const s = JSON.stringify(body)
    res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(s)
  }

  private authed(req: http.IncomingMessage, url: URL): boolean {
    const token = this.cfg?.token || ''
    if (!token) return false
    const hdr = req.headers['authorization'] || ''
    const bearer = Array.isArray(hdr) ? hdr[0] : hdr
    const fromHdr = bearer.replace(/^Bearer\s+/i, '')
    const fromQuery = url.searchParams.get('token') || ''
    const xtok = (req.headers['x-token'] as string) || ''
    return fromHdr === token || fromQuery === token || xtok === token
  }

  private async body(req: http.IncomingMessage): Promise<any> {
    return new Promise(resolve => {
      let data = ''
      req.on('data', c => { data += c; if (data.length > 1e6) req.destroy() })
      req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch { resolve(null) } })
    })
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'OPTIONS') { return this.send(res, 200, { ok: true }) }
    if (url.pathname === '/api/health') return this.send(res, 200, { ok: true, version: this.ctx.version })
    if (!this.authed(req, url)) return this.send(res, 401, { error: 'unauthorized' })

    try {
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        return this.send(res, 200, { projects: this.ctx.getConfig().projects.map(p => ({ name: p.name, color: p.color })) })
      }
      if (req.method === 'GET' && url.pathname === '/api/day') {
        const d = dayMs(url.searchParams.get('date') || '')
        if (d === null) return this.send(res, 400, { error: 'date=YYYY-MM-DD erforderlich' })
        return this.send(res, 200, serializeDay(d, this.ctx.deriveDay(d)))
      }
      if (req.method === 'POST' && url.pathname === '/api/assign') {
        const b = await this.body(req); if (!b) return this.send(res, 400, { error: 'ungültiges JSON' })
        const d = dayMs(b.date); if (d === null) return this.send(res, 400, { error: 'date=YYYY-MM-DD erforderlich' })
        const a = hhmmToMs(d, b.from); let z = hhmmToMs(d, b.to)
        if (a === null || z === null) return this.send(res, 400, { error: 'from/to als "HH:MM" erforderlich' })
        if (z <= a) z += 86400000 // Eintrag über Mitternacht (z. B. 21:30–00:30)
        const segs = applyRange(this.ctx.deriveDay(d), a, z, {
          kind: b.kind === 'break' ? 'break' : 'work', ticket: b.ticket ?? null,
          note: b.note ?? null, project: b.project ?? null, meeting: !!b.meeting
        })
        this.ctx.saveDay(d, segs); this.ctx.onChange()
        return this.send(res, 200, serializeDay(d, this.ctx.deriveDay(d)))
      }
      if (req.method === 'POST' && url.pathname === '/api/day') {
        const b = await this.body(req); if (!b) return this.send(res, 400, { error: 'ungültiges JSON' })
        const d = dayMs(b.date); if (d === null) return this.send(res, 400, { error: 'date=YYYY-MM-DD erforderlich' })
        if (!Array.isArray(b.segments)) return this.send(res, 400, { error: 'segments[] erforderlich' })
        const segs: Segment[] = []
        for (const x of b.segments) {
          const start = typeof x.start === 'number' ? x.start : hhmmToMs(d, x.from)
          let end = typeof x.end === 'number' ? x.end : hhmmToMs(d, x.to)
          // Bei HH:MM-Angabe bedeutet Ende <= Start „über Mitternacht" -> Folgetag.
          if (typeof x.end !== 'number' && end !== null && start !== null && end <= start) end += 86400000
          if (start === null || end === null || end <= start) continue
          segs.push({
            id: randomUUID(), start, end, kind: x.kind === 'break' ? 'break' : 'work',
            ticket: x.ticket ?? null, note: x.note ?? null, project: x.project ?? null,
            meeting: !!x.meeting, source: 'manual'
          })
        }
        this.ctx.saveDay(d, segs.sort((p, q) => p.start - q.start)); this.ctx.onChange()
        return this.send(res, 200, serializeDay(d, this.ctx.deriveDay(d)))
      }
      if (req.method === 'POST' && url.pathname === '/api/reset') {
        const b = await this.body(req); if (!b) return this.send(res, 400, { error: 'ungültiges JSON' })
        const d = dayMs(b.date); if (d === null) return this.send(res, 400, { error: 'date=YYYY-MM-DD erforderlich' })
        this.ctx.resetDay(d); this.ctx.onChange()
        return this.send(res, 200, { ok: true })
      }
      return this.send(res, 404, { error: 'not found' })
    } catch (e: any) {
      return this.send(res, 500, { error: String(e?.message || e) })
    }
  }
}
