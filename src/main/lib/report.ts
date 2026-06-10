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

// ---- Monatsbericht (für Projektmanager) ----

function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
}
const dec = (seconds: number) => (seconds / 3600).toFixed(2)
const esc = (v: string) => String(v).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
const pct = (part: number, total: number) => total > 0 ? `${Math.round(part / total * 100)} %` : '–'

interface ProjAgg { name: string; seconds: number; tickets: Record<string, number> }
interface WeekAgg { week: number; label: string; seconds: number; projects: Record<string, number> }

export interface MonthReport { year: number; month: number; key: string; html: string; csv: string; totalSeconds: number; workDays: number }

/** Monatsbericht: gruppiert nach Projekt/Ticket, Woche und Tag. month = 0..11. */
export function buildMonthReport(year: number, month: number, nowMs: number, graceSeconds: number, _config: AppConfig): MonthReport {
  const first = new Date(year, month, 1)
  const last = new Date(year, month + 1, 0)
  const projects: Record<string, ProjAgg> = {}
  const weeks: Record<number, WeekAgg> = {}
  const dayRows: { ms: number; worked: number; brk: number; items: Record<string, number> }[] = []
  let totalWorked = 0, totalBreak = 0, totalMeeting = 0, workDays = 0

  for (const d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const dayMs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const segs = segments(dayMs, nowMs, graceSeconds)
    if (!segs.length) continue
    let dayWorked = 0, dayBreak = 0
    const items: Record<string, number> = {}
    const wk = isoWeek(new Date(dayMs))
    for (const s of segs) {
      const dur = Math.max(0, s.end - s.start) / 1000
      if (s.kind === 'break') { dayBreak += dur; continue }
      dayWorked += dur
      const proj = s.meeting ? 'Meetings' : (s.project || 'Ohne Projekt')
      const ticket = s.meeting ? (s.ticket || 'Meeting') : (s.ticket || UNASSIGNED)
      if (s.meeting) totalMeeting += dur
      const p = projects[proj] || (projects[proj] = { name: proj, seconds: 0, tickets: {} })
      p.seconds += dur; p.tickets[ticket] = (p.tickets[ticket] || 0) + dur
      const w = weeks[wk] || (weeks[wk] = { week: wk, label: `KW ${wk}`, seconds: 0, projects: {} })
      w.seconds += dur; w.projects[proj] = (w.projects[proj] || 0) + dur
      const itemKey = proj + (ticket !== UNASSIGNED && ticket !== proj ? ` / ${ticket}` : '')
      items[itemKey] = (items[itemKey] || 0) + dur
    }
    totalWorked += dayWorked; totalBreak += dayBreak
    if (dayWorked > 0) workDays++
    dayRows.push({ ms: dayMs, worked: dayWorked, brk: dayBreak, items })
  }

  const monthLabel = first.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })
  const projList = Object.values(projects).sort((a, b) => b.seconds - a.seconds)
  const weekList = Object.values(weeks).sort((a, b) => a.week - b.week)
  const key = `${year}-${String(month + 1).padStart(2, '0')}`

  // ---- HTML ----
  const h: string[] = []
  h.push(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Monatsbericht ${esc(monthLabel)}</title>`)
  h.push(`<style>
    :root{--ink:#1d1d1f;--mut:#6e6e73;--line:#e3e3e6;--accent:#2f6df6;--bg:#f5f5f7}
    *{box-sizing:border-box} body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);margin:0;padding:32px;background:#fff}
    h1{font-size:24px;margin:0 0 4px} h2{font-size:16px;margin:28px 0 10px;border-bottom:2px solid var(--accent);padding-bottom:4px}
    .meta{color:var(--mut);margin-bottom:20px}
    .cards{display:flex;gap:12px;flex-wrap:wrap;margin:8px 0 4px}
    .card{background:var(--bg);border-radius:10px;padding:12px 16px;min-width:140px}
    .card b{display:block;font-size:22px} .card span{color:var(--mut);font-size:12px}
    table{border-collapse:collapse;width:100%;margin:6px 0 4px} th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)}
    th{color:var(--mut);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
    td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
    tr.proj td{font-weight:600;background:var(--bg)} tr.tick td:first-child{padding-left:26px;color:var(--mut)}
    .foot{color:var(--mut);font-size:12px;margin-top:28px}
    @media print{body{padding:0}}
  </style></head><body>`)
  h.push(`<h1>Monatsbericht – ${esc(monthLabel)}</h1>`)
  h.push(`<div class="meta">Erstellt am ${new Date(nowMs).toLocaleString('de-DE')} · WorkTracker</div>`)
  h.push(`<div class="cards">
    <div class="card"><b>${hm(totalWorked)}</b><span>Gesamt (${dec(totalWorked)} h)</span></div>
    <div class="card"><b>${workDays}</b><span>Arbeitstage</span></div>
    <div class="card"><b>${hm(workDays ? totalWorked / workDays : 0)}</b><span>Ø pro Arbeitstag</span></div>
    <div class="card"><b>${hm(totalMeeting)}</b><span>davon Meetings</span></div>
    <div class="card"><b>${hm(totalBreak)}</b><span>Pausen</span></div>
  </div>`)

  h.push(`<h2>Aufwand je Projekt &amp; Ticket</h2><table><thead><tr><th>Projekt / Ticket</th><th class="num">Stunden</th><th class="num">Dezimal</th><th class="num">Anteil</th></tr></thead><tbody>`)
  for (const p of projList) {
    h.push(`<tr class="proj"><td>${esc(p.name)}</td><td class="num">${hm(p.seconds)}</td><td class="num">${dec(p.seconds)}</td><td class="num">${pct(p.seconds, totalWorked)}</td></tr>`)
    for (const [tk, sec] of Object.entries(p.tickets).sort((a, b) => b[1] - a[1])) {
      h.push(`<tr class="tick"><td>${esc(tk)}</td><td class="num">${hm(sec)}</td><td class="num">${dec(sec)}</td><td class="num"></td></tr>`)
    }
  }
  h.push(`</tbody></table>`)

  h.push(`<h2>Aufwand je Woche</h2><table><thead><tr><th>Woche</th><th>Projekte</th><th class="num">Stunden</th><th class="num">Dezimal</th></tr></thead><tbody>`)
  for (const w of weekList) {
    const projs = Object.entries(w.projects).sort((a, b) => b[1] - a[1]).map(([n, s]) => `${esc(n)} (${hm(s)})`).join(', ')
    h.push(`<tr><td>${esc(w.label)}</td><td>${projs}</td><td class="num">${hm(w.seconds)}</td><td class="num">${dec(w.seconds)}</td></tr>`)
  }
  h.push(`</tbody></table>`)

  h.push(`<h2>Aufwand je Tag</h2><table><thead><tr><th>Datum</th><th>Projekte / Tickets</th><th class="num">Gearbeitet</th><th class="num">Pause</th></tr></thead><tbody>`)
  for (const r of dayRows) {
    const dl = new Date(r.ms).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })
    const its = Object.entries(r.items).sort((a, b) => b[1] - a[1]).map(([n, s]) => `${esc(n)} (${hm(s)})`).join(', ')
    h.push(`<tr><td>${dl}</td><td>${its}</td><td class="num">${hm(r.worked)}</td><td class="num">${r.brk > 0 ? hm(r.brk) : '–'}</td></tr>`)
  }
  h.push(`</tbody></table>`)
  h.push(`<div class="foot">Zeiten sind Ist-Aufwände (ungerundet). Meetings sind als eigenes „Projekt" geführt.</div>`)
  h.push(`</body></html>`)

  // ---- CSV (eine Zeile je Tag × Projekt/Ticket) ----
  const c: string[] = ['Datum;Woche;Projekt;Ticket;Stunden;Dezimal']
  const cesc = (v: string) => /[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  for (const r of dayRows) {
    const day = new Date(r.ms).toLocaleDateString('sv-SE')
    const wk = isoWeek(new Date(r.ms))
    for (const [item, sec] of Object.entries(r.items)) {
      const [proj, ticket] = item.includes(' / ') ? item.split(' / ') : [item, '']
      c.push([day, `KW ${wk}`, proj, ticket, hm(sec), dec(sec)].map(cesc).join(';'))
    }
  }

  return { year, month, key, html: h.join('\n'), csv: c.join('\n'), totalSeconds: totalWorked, workDays }
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
