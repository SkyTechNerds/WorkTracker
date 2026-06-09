// Tages-Report als Markdown oder CSV (portiert aus Swift Reporter).

import { Segment, AppConfig, UNASSIGNED } from './types'
import { segments, ticketTotals } from './day'

function hm(seconds: number): string {
  const t = Math.round(seconds); const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60)
  return `${h}h ${String(m).padStart(2, '0')}m`
}
function clock(ms: number): string {
  const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString('de-DE', { weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' })
}

function round(seconds: number, roundingMinutes: number): number {
  if (roundingMinutes <= 0) return seconds
  const step = roundingMinutes * 60
  return Math.round(seconds / step) * step
}

export function reportMarkdown(dateMs: number, nowMs: number, graceSeconds: number, config: AppConfig): string {
  const segs = segments(dateMs, nowMs, graceSeconds)
  const work = segs.filter(s => s.kind === 'work')
  const breaks = segs.filter(s => s.kind === 'break')
  const dur = (s: Segment) => Math.max(0, s.end - s.start) / 1000
  const worked = work.reduce((a, s) => a + dur(s), 0)
  const paused = breaks.reduce((a, s) => a + dur(s), 0)
  const start = segs.length ? Math.min(...segs.map(s => s.start)) : null
  const end = segs.length ? Math.max(...segs.map(s => s.end)) : null

  const lines: string[] = []
  lines.push(`# Arbeitszeit – ${dayLabel(dateMs)}`, '')
  lines.push(`- **Arbeitsbeginn:** ${start ? clock(start) : '–'}`)
  lines.push(`- **Arbeitsende:** ${end ? clock(end) : '–'}`)
  lines.push(`- **Gearbeitet:** ${hm(worked)}`)
  lines.push(`- **Pause:** ${hm(paused)}`, '')

  lines.push('## Zeit je Ticket', '')
  lines.push('| Ticket | Zeit | gerundet |', '|---|---|---|')
  for (const t of ticketTotals(dateMs, nowMs, graceSeconds)) {
    lines.push(`| ${t.ticket} | ${hm(t.seconds)} | ${hm(round(t.seconds, config.roundingMinutes))} |`)
  }
  lines.push('')

  lines.push('## Verlauf', '')
  lines.push('| Von | Bis | Art | Ticket | Notiz |', '|---|---|---|---|---|')
  for (const s of segs) {
    const art = s.kind === 'work' ? 'Arbeit' : 'Pause'
    lines.push(`| ${clock(s.start)} | ${clock(s.end)} | ${art} | ${s.kind === 'work' ? (s.ticket || UNASSIGNED) : ''} | ${s.note || ''} |`)
  }
  lines.push('')
  return lines.join('\n')
}

export function reportCsv(dateMs: number, nowMs: number, graceSeconds: number): string {
  const segs = segments(dateMs, nowMs, graceSeconds)
  const esc = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  const rows: string[] = ['Datum,Von,Bis,Art,Ticket,Notiz,Minuten']
  const day = new Date(dateMs).toLocaleDateString('sv-SE')
  for (const s of segs) {
    const art = s.kind === 'work' ? 'Arbeit' : 'Pause'
    const mins = Math.round((s.end - s.start) / 60000)
    rows.push([day, clock(s.start), clock(s.end), art, s.kind === 'work' ? (s.ticket || UNASSIGNED) : '', s.note || '', String(mins)].map(esc).join(','))
  }
  return rows.join('\n')
}
