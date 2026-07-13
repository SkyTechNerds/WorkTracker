// Tages-Report (Markdown/CSV) + Monatsbericht (HTML/CSV) für Projektmanager.

import { Segment, AppConfig, UNASSIGNED } from './types'
import { segments, ticketTotals, summary } from './day'
import { isDayEnded } from './store'
import { computeOvertime } from './overtime'

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

// ================= Monatsbericht (Projektmanager-Auswertung) =================

const PALETTE = ['#2563eb', '#f97316', '#16a34a', '#7c3aed', '#db2777', '#0891b2', '#ca8a04', '#9333ea', '#0d9488', '#64748b']
// Kategorie-Farben (Tages-/Wochenbalken) – getrennt von Projektfarben.
const CAT = { customer: '#2563eb', internal: '#7c3aed', meeting: '#db2777', pause: '#94a3b8', open: '#e2e8f0' }
type Cat = 'customer' | 'internal' | 'meeting' | 'pause'

const esc = (v: string) => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))
const dec = (sec: number) => (sec / 3600).toFixed(2)
const pct = (part: number, total: number) => total > 0 ? `${Math.round(part / total * 100)}%` : '–'

function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
}

interface DayData {
  ms: number; weekend: boolean; future: boolean; planrelevant: boolean
  cats: Record<Cat, number>; work: number; pause: number; fill: number; open: number
  projects: Record<string, number>; items: { label: string; seconds: number; note: string }[]; hasBooking: boolean
}

export interface MonthReport { year: number; month: number; key: string; html: string; csv: string; totalSeconds: number; workDays: number }

export function buildMonthReport(year: number, month: number, nowMs: number, graceSeconds: number, config: AppConfig): MonthReport {
  return buildReport(new Date(year, month, 1).getTime(), new Date(year, month + 1, 0).getTime(), nowMs, graceSeconds, config)
}

// Generischer Bericht über einen beliebigen Zeitraum [fromMs, toMs] (Tag/Woche/Monat/Jahr/frei).
export function buildReport(fromMs: number, toMs: number, nowMs: number, graceSeconds: number, config: AppConfig): MonthReport {
  const TARGET = (config.targetHoursPerDay || 8) * 3600
  const workdays = config.workdayWeekdays || [2, 3, 4, 5, 6] // 1=So..7=Sa
  const isWorkday = (d: Date) => workdays.includes(d.getDay() + 1)
  const internalSet = new Set((config.projects || []).filter(p => p.internal).map(p => p.name))
  const projColor = (name: string, idx: number) => {
    const c = config.projects?.find(p => p.name === name)?.color
    if (c) return c
    if (name === 'Meetings') return CAT.meeting
    if (name === 'Ohne Projekt' || name === 'Intern') return CAT.internal
    return PALETTE[idx % PALETTE.length]
  }

  const first = (() => { const d = new Date(fromMs); d.setHours(0, 0, 0, 0); return d })()
  const last = (() => { const d = new Date(toMs); d.setHours(0, 0, 0, 0); return d })()
  const todayStart = new Date(nowMs); todayStart.setHours(0, 0, 0, 0)
  const cutoff = Math.min(last.getTime(), todayStart.getTime())
  const rangeDays = Math.round((last.getTime() - first.getTime()) / 86400000) + 1
  const showCalendar = rangeDays <= 45 // Kalenderraster nur für überschaubare Zeiträume (Tag/Woche/Monat)

  const days: DayData[] = []
  const projAgg: Record<string, { name: string; seconds: number; tickets: Record<string, number>; color: string }> = {}
  let totalWork = 0, totalPause = 0, totalMeeting = 0, totalInternal = 0, totalCustomer = 0
  let bookedDays = 0, totalOpen = 0, emptyWorkdays = 0, fullDays = 0, underDays = 0, weekdaysInMonth = 0
  // Über-/Minusstunden-Saldo (gleiche Logik wie der Überstunden-Tab): Ist − Soll über
  // abgeschlossene Tage. Leere planrelevante Tage (Urlaub/krank) NICHT als Minus werten,
  // laufenden Tag (heute, noch kein Feierabend) ausklammern -> kein künstliches −8h.
  let saldoIst = 0, saldoSoll = 0

  for (const dd = new Date(first); dd <= last; dd.setDate(dd.getDate() + 1)) {
    const ms = new Date(dd.getFullYear(), dd.getMonth(), dd.getDate()).getTime()
    const d = new Date(ms)
    const weekend = !isWorkday(d)
    if (!weekend) weekdaysInMonth++
    const future = ms > cutoff
    const segs = future ? [] : segments(ms, nowMs, graceSeconds)
    const cats: Record<Cat, number> = { customer: 0, internal: 0, meeting: 0, pause: 0 }
    const projects: Record<string, number> = {}
    const itemsMap: Record<string, number> = {}
    const itemNotes: Record<string, Set<string>> = {}
    for (const s of segs) {
      const sec = Math.max(0, s.end - s.start) / 1000
      if (s.kind === 'break') { cats.pause += sec; continue }
      const cat: Cat = s.meeting ? 'meeting' : (s.project && !internalSet.has(s.project)) ? 'customer' : 'internal'
      cats[cat] += sec
      const proj = s.project || (s.meeting ? 'Meetings' : 'Ohne Projekt')
      projects[proj] = (projects[proj] || 0) + sec
      const pa = projAgg[proj] || (projAgg[proj] = { name: proj, seconds: 0, tickets: {}, color: '' })
      pa.seconds += sec
      const tk = s.meeting ? (s.ticket || 'Meeting') : (s.ticket || UNASSIGNED)
      pa.tickets[tk] = (pa.tickets[tk] || 0) + sec
      const ik = proj + (tk && tk !== UNASSIGNED && tk !== proj ? ` / ${tk}` : '')
      itemsMap[ik] = (itemsMap[ik] || 0) + sec
      if (s.note) (itemNotes[ik] || (itemNotes[ik] = new Set())).add(s.note.trim())
    }
    const work = cats.customer + cats.internal + cats.meeting
    const pause = cats.pause
    const fill = work + pause
    const hasBooking = fill > 0
    const open = (!weekend && !future && hasBooking) ? Math.max(0, TARGET - fill) : 0
    totalWork += work; totalPause += pause; totalMeeting += cats.meeting; totalInternal += cats.internal; totalCustomer += cats.customer
    if (hasBooking) { bookedDays++; totalOpen += open; if (fill >= TARGET) fullDays++; else underDays++ }
    else if (!weekend && !future) emptyWorkdays++
    // Saldo: nur abgeschlossene Tage; laufenden Tag + leere Arbeitstage überspringen.
    const pending = ms === todayStart.getTime() && !isDayEnded(ms)
    if (!future && !pending && !(work <= 0 && !weekend)) {
      const targetSec = weekend ? 0 : TARGET // Wochenendarbeit = reine Überstunde (Soll 0)
      saldoIst += work; saldoSoll += targetSec
    }
    const items = Object.entries(itemsMap).map(([label, seconds]) => ({ label, seconds, note: itemNotes[label] ? [...itemNotes[label]].join(' · ') : '' })).sort((a, b) => b.seconds - a.seconds)
    days.push({ ms, weekend, future, planrelevant: !weekend && !future, cats, work, pause, fill, open, projects, items, hasBooking })
  }

  const projList = Object.values(projAgg).sort((a, b) => b.seconds - a.seconds)
  projList.forEach((p, i) => { p.color = projColor(p.name, i) })

  // Wochen
  interface WeekAgg { week: number; first: number; last: number; cats: Record<Cat, number>; soll: number; booking: number }
  const weeks: Record<number, WeekAgg> = {}
  for (const day of days) {
    const wk = isoWeek(new Date(day.ms))
    const w = weeks[wk] || (weeks[wk] = { week: wk, first: day.ms, last: day.ms, cats: { customer: 0, internal: 0, meeting: 0, pause: 0 }, soll: 0, booking: 0 })
    ;(['customer', 'internal', 'meeting', 'pause'] as Cat[]).forEach(k => { w.cats[k] += day.cats[k] })
    if (day.planrelevant) w.soll += TARGET
    w.booking += day.fill
    w.first = Math.min(w.first, day.ms); w.last = Math.max(w.last, day.ms)
  }
  const weekList = Object.values(weeks).sort((a, b) => a.week - b.week)

  // Zeitraum-Label/Typ ableiten (Tag / Woche / Monat / Jahr / freier Bereich).
  const sameDay = first.getTime() === last.getTime()
  const dStr = (d: Date) => d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const isFullMonth = first.getDate() === 1 && first.getFullYear() === last.getFullYear() && first.getMonth() === last.getMonth() && last.getDate() === new Date(last.getFullYear(), last.getMonth() + 1, 0).getDate()
  const isFullYear = first.getMonth() === 0 && first.getDate() === 1 && last.getMonth() === 11 && last.getDate() === 31 && first.getFullYear() === last.getFullYear()
  const isWeek = rangeDays === 7 && first.getDay() === 1
  let periodKind: string, monthLabel: string, key: string
  if (sameDay) { periodKind = 'Tagesbericht'; monthLabel = first.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }); key = first.toLocaleDateString('sv-SE') }
  else if (isWeek) { periodKind = 'Wochenbericht'; monthLabel = `KW ${isoWeek(first)} (${dStr(first)} – ${dStr(last)})`; key = `${first.getFullYear()}-KW${String(isoWeek(first)).padStart(2, '0')}` }
  else if (isFullMonth) { periodKind = 'Monatsbericht'; monthLabel = first.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }); key = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, '0')}` }
  else if (isFullYear) { periodKind = 'Jahresbericht'; monthLabel = String(first.getFullYear()); key = String(first.getFullYear()) }
  else { periodKind = 'Auswertung'; monthLabel = `${dStr(first)} – ${dStr(last)}`; key = `${first.toLocaleDateString('sv-SE')}_${last.toLocaleDateString('sv-SE')}` }
  const who = (config.employeeName || '').trim()
  const top = projList[0]
  const status = emptyWorkdays > 0 ? 'Prüfen' : 'Vollständig'
  const saldo = saldoIst - saldoSoll
  const saldoStr = `${saldo >= 0 ? '+' : '−'}${hm(Math.abs(saldo))}`
  // Gesamt-Saldo (kumuliert über die ganze Historie) bis zum Zeitraum-Ende (max. heute):
  // aktueller Zeitraum -> aktueller Kontostand (wie Überstunden-Tab), Vergangenheit -> Stand
  // zum Periodenende. Inkl. konfiguriertem Startsaldo.
  const gesamtHours = computeOvertime(config, nowMs, graceSeconds, cutoff).balanceHours
  const gesamtSec = gesamtHours * 3600
  const gesamtStr = `${gesamtHours >= 0 ? '+' : '−'}${hm(Math.abs(gesamtSec))}`
  const gesamtStand = new Date(cutoff).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })

  // ---- Auffälligkeiten (regelbasiert) ----
  const insights: { t: string; p: string }[] = []
  if (cutoff < last.getTime()) insights.push({ t: `Laufender Zeitraum – Stand ${new Date(cutoff).toLocaleDateString('de-DE')}`, p: 'Tage nach dem Stichtag werden nicht als fehlend gewertet.' })
  if (emptyWorkdays > 0) insights.push({ t: `${emptyWorkdays} planrelevante Tag(e) ohne Buchung`, p: 'Im Kalender als „keine Buchung" sichtbar – ggf. Urlaub/Krank oder fehlende Erfassung.' })
  const emptyWeeks = weekList.filter(w => w.booking === 0)
  if (emptyWeeks.length) insights.push({ t: `KW ${emptyWeeks.map(w => w.week).join(', ')} ohne Buchungen`, p: 'Ganze Woche(n) ohne erfasste Zeit.' })
  if (underDays > 0) insights.push({ t: `${underDays} Tag(e) unter ${hm(TARGET)} Soll`, p: 'Differenz bis zur 8h-Tagesreferenz = nicht gebuchte Sollzeit.' })
  if (totalMeeting >= 60) insights.push({ t: `Meeting-Anteil ${pct(totalMeeting, totalWork)}`, p: `${hm(totalMeeting)} von ${hm(totalWork)} gebuchter Arbeit entfallen auf Meetings.` })
  if (top) insights.push({ t: `Top-Projekt ${esc(top.name)} = ${pct(top.seconds, totalWork)}`, p: `${hm(top.seconds)} – größter Anteil im Zeitraum.` })

  // ---- Helfer: gestapelter Tagesbalken ----
  const stack = (cats: Record<Cat, number>, open: number, denomBase: number) => {
    const fill = cats.customer + cats.internal + cats.meeting + cats.pause
    const denom = Math.max(denomBase, fill)
    const seg = (cls: string, sec: number, label: string) => sec > 0 ? `<span class="seg ${cls}" style="width:${(sec / denom * 100).toFixed(3)}%" title="${label}: ${hm(sec)}"></span>` : ''
    return seg('work', cats.customer, 'Kundenprojekt') + seg('intern', cats.internal, 'Intern') + seg('meetings', cats.meeting, 'Meeting')
      + seg('pause', cats.pause, 'Pause') + (open > 0 ? `<span class="seg open" style="width:${(open / denom * 100).toFixed(3)}%" title="Nicht gebuchte Sollzeit: ${hm(open)}"></span>` : '')
  }

  // ---- Kalenderzellen ----
  const lead = (first.getDay() + 6) % 7 // Mo-basierter Offset des 1.
  const cells: string[] = []
  for (let i = 0; i < lead; i++) cells.push(`<article class="day outside"></article>`)
  for (const day of days) {
    const d = new Date(day.ms)
    const dnum = d.getDate(); const dow = d.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')
    const head = `<div class="day-head"><strong>${dnum}</strong><span>${dow}</span></div>`
    if (day.weekend) { cells.push(`<article class="day weekend">${head}<div class="stack"><span class="seg weekendseg" style="width:100%"></span></div><div class="day-total muted">Wochenende</div></article>`); continue }
    if (day.future) { cells.push(`<article class="day future">${head}<div class="stack"></div><div class="day-total muted">–</div></article>`); continue }
    if (!day.hasBooking) { cells.push(`<article class="day empty-workday">${head}<div class="stack"><span class="seg noentry" style="width:100%"></span></div><div class="day-total muted">keine Buchung</div></article>`); continue }
    const over = day.fill > TARGET ? day.fill - TARGET : 0
    const pills = Object.entries(day.projects).filter(([, s]) => s >= 60).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, s]) => `<span>${esc(n)} ${hm(s)}</span>`).join('')
    const totalLbl = `${hm(day.fill > TARGET ? TARGET : day.fill)} / ${hm(TARGET)}${over > 0 ? ` <em class="over">+${hm(over)}</em>` : ''}`
    cells.push(`<article class="day booked">${head}<div class="stack">${stack(day.cats, day.open, TARGET)}</div><div class="day-total">${totalLbl}</div><div class="day-pills">${pills}</div></article>`)
  }
  while (cells.length % 7 !== 0) cells.push(`<article class="day outside"></article>`)

  // ---- Wochen-Tabelle ----
  const weekRows = weekList.map(w => {
    const fill = w.cats.customer + w.cats.internal + w.cats.meeting + w.cats.pause
    const work = w.cats.customer + w.cats.internal + w.cats.meeting
    const open = Math.max(0, w.soll - fill)
    const range = `${new Date(w.first).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}–${new Date(w.last).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}`
    const denom = Math.max(w.soll, fill, 1)
    const seg = (cls: string, sec: number) => sec > 0 ? `<span class="seg ${cls}" style="width:${(sec / denom * 100).toFixed(2)}%"></span>` : ''
    const mini = w.booking === 0 ? '' : seg('work', w.cats.customer) + seg('intern', w.cats.internal) + seg('meetings', w.cats.meeting) + seg('pause', w.cats.pause) + (open > 0 ? `<span class="seg open" style="width:${(open / denom * 100).toFixed(2)}%"></span>` : '')
    const badge = w.booking === 0 ? `<span class="badge keinebuchung">keine Buchung</span>` : open > 0 ? `<span class="badge offen">Rest ${hm(open)}</span>` : `<span class="badge voll">vollständig</span>`
    return `<tr><td><strong>KW ${w.week}</strong><small>${range}</small></td><td><div class="mini-stack">${mini}</div></td><td class="num">${hm(work)}</td><td class="num">${hm(w.cats.pause)}</td><td class="num">${hm(w.soll)}</td><td>${badge}</td></tr>`
  }).join('')

  // ---- Projektkarten (0-Minuten-Einträge ausblenden) ----
  const visProj = projList.filter(p => p.seconds >= 60)
  const projCards = visProj.map(p => {
    const tickets = Object.entries(p.tickets).filter(([, s]) => s >= 60).sort((a, b) => b[1] - a[1]).map(([t, s]) => `<li><span>${esc(t)}</span><b>${hm(s)}</b></li>`).join('')
    return `<article class="project-card"><div class="project-main"><div><span class="dot" style="background:${p.color}"></span><strong>${esc(p.name)}</strong></div><b>${hm(p.seconds)}</b><em>${pct(p.seconds, totalWork)}</em></div><div class="project-bar"><span style="width:${(totalWork > 0 ? p.seconds / totalWork * 100 : 0).toFixed(2)}%;background:${p.color}"></span></div><ul>${tickets}</ul></article>`
  }).join('')
  const projLegend = visProj.map(p => `<span><i class="dot" style="background:${p.color}"></i>${esc(p.name)}</span>`).join('')

  // ---- Tagesdetails (lesbare Timesheet-Blöcke pro Tag) ----
  // Nur Tage mit Buchung; je Tag eine Aufgabenliste mit Beschreibung + Dauer.
  const detailCards = days.filter(d => d.hasBooking).map(d => {
    const dt = new Date(d.ms)
    const dname = dt.toLocaleDateString('de-DE', { weekday: 'long' }); const ddate = dt.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const badge = d.fill >= TARGET ? `<span class="badge voll">vollständig</span>` : `<span class="badge unter8h">unter ${hm(TARGET)}</span>`
    const rows = d.items.filter(it => it.seconds >= 60).map(it => {
      const [proj, tk] = it.label.includes(' / ') ? it.label.split(' / ') : [it.label, '']
      return `<tr><td class="dd-task"><b>${esc(tk || proj)}</b>${tk ? `<small>${esc(proj)}</small>` : ''}</td><td class="dd-note">${it.note ? esc(it.note) : '<span class="dd-empty">—</span>'}</td><td class="num">${hm(it.seconds)}</td></tr>`
    }).join('')
    return `<div class="day-detail"><div class="dd-head"><b>${dname}, ${ddate}</b><span class="dd-sum">Arbeit ${hm(d.work)}${d.pause > 0 ? ` · Pause ${hm(d.pause)}` : ''} ${badge}</span></div>`
      + `<table class="dd-table"><thead><tr><th>Aufgabe</th><th>Tätigkeit / Beschreibung</th><th class="num">Dauer</th></tr></thead><tbody>${rows}</tbody></table></div>`
  }).join('')

  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(periodKind)} ${esc(monthLabel)}${who ? ' – ' + esc(who) : ''}</title>
<style>
:root{--bg:#f4f6f8;--paper:#fff;--ink:#172033;--muted:#667085;--line:#dce3eb;--work:${CAT.customer};--intern:${CAT.internal};--meetings:${CAT.meeting};--pause:${CAT.pause};--open:${CAT.open};--weekend:#f8fafc;--ok:#dcfce7;--warn:#fff7ed}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
.page{max-width:1360px;margin:0 auto;padding:28px}
.hero{background:linear-gradient(135deg,#101828,#243b67);color:#fff;border-radius:28px;padding:26px 28px;display:grid;grid-template-columns:1.2fr auto;gap:24px;box-shadow:0 18px 60px rgba(16,24,40,.18)}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#bcc7da;font-weight:700;margin-bottom:8px}
h1{margin:0;font-size:34px;line-height:1.08;letter-spacing:-.04em}.hero p{margin:8px 0 0;color:#d7deea;max-width:640px}
.report-meta{display:grid;grid-template-columns:repeat(2,minmax(130px,1fr));gap:10px;align-self:start}
.meta-card{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.16);border-radius:16px;padding:12px 14px}
.meta-card span{display:block;color:#c9d3e4;font-size:12px}.meta-card b{display:block;font-size:18px;margin-top:2px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:16px}
.kpi{background:var(--paper);border:1px solid var(--line);border-radius:20px;padding:16px;box-shadow:0 10px 30px rgba(16,24,40,.05)}
.kpi span{font-size:12px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.04em}.kpi b{display:block;margin-top:8px;font-size:24px;letter-spacing:-.03em}.kpi small{display:block;margin-top:4px;color:var(--muted)}
.kpi.saldo{border-color:#cbd5e1}.kpi b.pos{color:#16a34a}.kpi b.neg{color:#dc2626}
.section{margin-top:18px;background:var(--paper);border:1px solid var(--line);border-radius:26px;padding:20px;box-shadow:0 10px 30px rgba(16,24,40,.05)}
.section-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:16px;flex-wrap:wrap}
h2{margin:0;font-size:22px;letter-spacing:-.03em}.section-head p{margin:4px 0 0;color:var(--muted)}
.legend{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;font-size:12px;color:#344054}
.legend span{display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
.swatch,.dot,.legend i{width:10px;height:10px;border-radius:999px;display:inline-block;vertical-align:middle}
.swatch.work{background:var(--work)}.swatch.intern{background:var(--intern)}.swatch.meetings{background:var(--meetings)}.swatch.pause{background:var(--pause)}.swatch.open{background:var(--open);border:1px solid #cbd5e1}.swatch.weekend{background:#f1f5f9;border:1px dashed #cbd5e1}
.grid-2{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:18px}
.calendar-scroll{overflow:auto}.calendar{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:8px;min-width:760px}
.weekday{font-size:12px;color:var(--muted);font-weight:800;text-transform:uppercase;letter-spacing:.05em;padding:0 8px 2px}
.day{min-height:120px;border:1px solid var(--line);background:#fff;border-radius:16px;padding:10px;display:flex;flex-direction:column;gap:8px;overflow:hidden}
.day.outside{visibility:hidden}.day.weekend{background:var(--weekend);color:#94a3b8}.day.empty-workday{border-style:dashed}.day.future{opacity:.45}
.day-head{display:flex;justify-content:space-between;align-items:center}.day-head strong{font-size:18px;letter-spacing:-.03em}.day-head span{font-size:12px;color:var(--muted);font-weight:700}
.stack,.mini-stack{height:12px;background:#eef2f7;border-radius:999px;overflow:hidden;display:flex;border:1px solid rgba(0,0,0,.04)}
.mini-stack{height:14px;min-width:200px}
.seg{display:block;height:100%;flex:0 0 auto}.seg.work{background:var(--work)}.seg.intern{background:var(--intern)}.seg.meetings{background:var(--meetings)}.seg.pause{background:var(--pause)}.seg.open{background:var(--open)}.seg.weekendseg{background:#f1f5f9}.seg.noentry{background:repeating-linear-gradient(45deg,#f8fafc 0,#f8fafc 5px,#edf2f7 5px,#edf2f7 10px)}
.day-total{font-weight:800;font-size:13px}.day-total .over{color:#ea580c;font-style:normal;font-weight:700}.muted{color:#94a3b8;font-weight:600}
.day-pills{display:flex;flex-wrap:wrap;gap:4px;margin-top:auto}.day-pills span{font-size:10.5px;color:#475467;background:#f2f4f7;border-radius:999px;padding:2px 6px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aside{display:flex;flex-direction:column;gap:12px}.note{border:1px solid var(--line);background:#f8fafc;border-radius:18px;padding:14px}.note h3{margin:0 0 8px;font-size:14px}.note p{margin:0;color:var(--muted)}
.util{display:grid;grid-template-columns:1fr 1fr;gap:10px}.util div{background:#fff;border:1px solid var(--line);border-radius:16px;padding:12px}.util span{display:block;color:var(--muted);font-size:12px}.util b{display:block;font-size:20px;margin-top:3px}
.projects{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
.project-card{border:1px solid var(--line);border-radius:20px;padding:14px;background:#fff}
.project-main{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center}.project-main>div:first-child{display:flex;align-items:center;gap:8px}.project-main strong{font-size:15px}.project-main b{font-size:16px}.project-main em{font-style:normal;color:var(--muted);font-size:12px}
.project-bar{height:10px;background:#eef2f7;border-radius:99px;overflow:hidden;margin:12px 0}.project-bar span{display:block;height:100%;border-radius:99px}
ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}li{display:flex;justify-content:space-between;gap:10px;color:#475467;font-size:12px}li span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}li b{color:#344054;flex-shrink:0;white-space:nowrap}
.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:18px}table{width:100%;border-collapse:collapse;background:#fff}th,td{padding:11px 12px;text-align:left;border-bottom:1px solid var(--line);vertical-align:middle}th{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;background:#f8fafc}tr:last-child td{border-bottom:0}.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}td small{display:block;color:var(--muted);margin-top:2px}
.day-details{display:flex;flex-direction:column;gap:14px}
.day-detail{border:1px solid var(--line);border-radius:16px;overflow:hidden;background:#fff}
.dd-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px;background:#f8fafc;border-bottom:1px solid var(--line);flex-wrap:wrap}
.dd-head>b{font-size:15px}.dd-sum{color:var(--muted);font-size:13px;display:inline-flex;align-items:center;gap:8px}
.dd-table{width:100%;border-collapse:collapse;background:#fff}
.dd-table th{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);text-align:left;padding:8px 16px;font-weight:600;background:#fff;border:0}
.dd-table td{padding:9px 16px;border-top:1px solid var(--line);border-bottom:0;vertical-align:top;font-size:13px}
.dd-table td.dd-task{width:200px}.dd-task b{display:block}.dd-task small{color:var(--muted);font-size:11px}
.dd-note{color:#475467;line-height:1.45}.dd-empty{color:#cbd5e1}
.dd-table td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;font-weight:700;width:90px}
.badge{display:inline-flex;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:800;background:#f2f4f7;color:#475467}.badge.voll{background:var(--ok);color:#166534}.badge.offen,.badge.unter8h{background:var(--warn);color:#9a3412}.badge.frei{background:#f1f5f9;color:#64748b}.badge.keinebuchung{background:#fee2e2;color:#991b1b}
.insights{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}.insight{border:1px solid var(--line);border-radius:18px;padding:14px;background:#fff}.insight b{display:block;margin-bottom:5px}.insight p{margin:0;color:var(--muted)}
.footer{color:var(--muted);font-size:12px;text-align:center;margin:20px 0}
@media(max-width:1120px){.hero,.grid-2{grid-template-columns:1fr}.kpis{grid-template-columns:repeat(3,1fr)}}
@media print{body{background:#fff}.page{max-width:none;padding:0}.hero,.section,.kpi{box-shadow:none}.calendar{min-width:0}}
</style></head><body><div class="page">
<header class="hero">
  <div><div class="eyebrow">WorkTracker · Auswertung · ${esc(status)}</div><h1>${esc(periodKind)} ${esc(monthLabel)}</h1><p>Übersicht für Projektmanager: Auslastung, Tageslogik (8h-Referenz), Projektanteile, Tickets und nicht gebuchte Sollzeit in einer kompakten Report-Seite.</p></div>
  <div class="report-meta"><div class="meta-card"><span>Mitarbeiter</span><b>${who ? esc(who) : '–'}</b></div><div class="meta-card"><span>Stand</span><b>${new Date(nowMs).toLocaleDateString('de-DE')}</b></div><div class="meta-card"><span>Tage im Zeitraum</span><b>${rangeDays}</b></div><div class="meta-card"><span>Arbeitstage (Mo–Fr)</span><b>${weekdaysInMonth} Tage</b></div></div>
</header>
<section class="kpis">
  <div class="kpi"><span>Gebuchte Arbeit</span><b>${hm(totalWork)}</b><small>ohne Pausen (${dec(totalWork)} h)</small></div>
  <div class="kpi"><span>Gebuchte Tage</span><b>${bookedDays}</b><small>mit Aufwandseinträgen</small></div>
  <div class="kpi"><span>Ø Arbeit / Tag</span><b>${hm(bookedDays ? totalWork / bookedDays : 0)}</b><small>bei gebuchten Tagen</small></div>
  <div class="kpi"><span>Meetings</span><b>${hm(totalMeeting)}</b><small>${pct(totalMeeting, totalWork)} der Arbeit</small></div>
  <div class="kpi"><span>Pausen</span><b>${hm(totalPause)}</b><small>nicht abrechenbar</small></div>
  <div class="kpi"><span>Nicht gebuchte Sollzeit</span><b>${hm(totalOpen)}</b><small>Rest bis ${hm(TARGET)} an gebuchten Tagen</small></div>
  <div class="kpi saldo"><span>Gesamt-Saldo</span><b class="${gesamtHours >= 0 ? 'pos' : 'neg'}">${gesamtStr}</b><small>Über-/Minusstunden gesamt · Stand ${gesamtStand}</small></div>
  <div class="kpi saldo"><span>Saldo Zeitraum</span><b class="${saldo >= 0 ? 'pos' : 'neg'}">${saldoStr}</b><small>Ist ${hm(saldoIst)} − Soll ${hm(saldoSoll)}${saldoIst === 0 && saldoSoll === 0 ? ' (offen)' : ''}</small></div>
</section>
${showCalendar ? `<section class="section">
  <div class="section-head"><div><h2>Arbeitsverlauf nach Kalenderlogik</h2><p>Alle Tage des Zeitraums sichtbar. Jeder gebuchte Arbeitstag nutzt ${hm(TARGET)} als Referenz: Kunde + Intern + Meeting + Pause + ggf. nicht gebuchte Sollzeit.</p></div>
  <div class="legend"><span><i class="swatch work"></i>Kundenprojekt</span><span><i class="swatch intern"></i>Intern</span><span><i class="swatch meetings"></i>Meeting</span><span><i class="swatch pause"></i>Pause</span><span><i class="swatch open"></i>nicht gebuchte Sollzeit</span><span><i class="swatch weekend"></i>Wochenende / keine Buchung</span></div></div>
  <div class="grid-2">
    <div class="calendar-scroll"><div class="calendar"><div class="weekday">Mo</div><div class="weekday">Di</div><div class="weekday">Mi</div><div class="weekday">Do</div><div class="weekday">Fr</div><div class="weekday">Sa</div><div class="weekday">So</div>${cells.join('')}</div></div>
    <aside class="aside">
      <div class="note"><h3>Leselogik</h3><p>Die Balken sind keine absoluten Balkendiagramme, sondern Tagesfüllstände auf ${hm(TARGET)}. So bleibt erkennbar, ob ein Tag vollständig erklärt ist.</p></div>
      <div class="util"><div><span>Voll erklärt</span><b>${fullDays} Tage</b></div><div><span>Unter ${hm(TARGET)}</span><b>${underDays} Tage</b></div><div><span>Meetinganteil</span><b>${hm(totalMeeting)}</b></div><div><span>Top-Projekt</span><b>${top ? esc(top.name) : '–'}</b></div></div>
      ${insights[0] ? `<div class="note"><h3>PM-Hinweis</h3><p><b>${esc(insights[0].t)}.</b> ${esc(insights[0].p)}</p></div>` : ''}
    </aside>
  </div>
</section>` : ''}
<section class="section"><div class="section-head"><div><h2>Wochenvergleich</h2><p>Wöchentliche Verdichtung mit derselben Farblogik wie der Kalender. Wochen-Soll nur für Tage im Zeitraum.</p></div></div>
  <div class="table-wrap"><table><thead><tr><th>Woche</th><th>Füllstand</th><th class="num">Arbeit</th><th class="num">Pause</th><th class="num">Soll</th><th>Status</th></tr></thead><tbody>${weekRows}</tbody></table></div></section>
<section class="section"><div class="section-head"><div><h2>Projekt- und Ticketanteile</h2><p>Verteilung nach Kunde/Projekt – inkl. Meetings, die einem Kunden zugeordnet sind (abrechenbar).</p></div><div class="legend">${projLegend}</div></div>
  <div class="projects">${projCards}</div></section>
<section class="section"><div class="section-head"><div><h2>Auffälligkeiten für PM-Review</h2><p>Keine Bewertung, sondern schnelle Prüfpunkte für Statusgespräch oder Rechnungsvorbereitung.</p></div></div>
  <div class="insights">${insights.map(i => `<article class="insight"><b>${esc(i.t)}</b><p>${esc(i.p)}</p></article>`).join('')}</div></section>
<section class="section"><div class="section-head"><div><h2>Tagesdetails</h2><p>Je Tag die geleisteten Aufgaben mit Beschreibung und Dauer – für Projektmanager und Kunde nachvollziehbar.</p></div></div>
  <div class="day-details">${detailCards}</div></section>
<div class="footer">WorkTracker · ${esc(periodKind)} ${esc(monthLabel)}${who ? ' · ' + esc(who) : ''} · Ist-Aufwände, ${hm(TARGET)}-Tagesreferenz</div>
</div></body></html>`

  // ---- CSV (eine Zeile je Tag × Projekt/Ticket) ----
  const cesc = (v: string) => /[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  const c: string[] = ['Datum;Woche;Kategorie;Projekt;Ticket;Stunden;Dezimal']
  for (const day of days) {
    if (!day.hasBooking) continue
    const date = new Date(day.ms).toLocaleDateString('sv-SE'); const wk = `KW ${isoWeek(new Date(day.ms))}`
    for (const it of day.items) {
      if (it.seconds < 60) continue
      const [proj, ticket] = it.label.includes(' / ') ? it.label.split(' / ') : [it.label, '']
      const catName = proj === 'Meetings' ? 'Meeting' : internalSet.has(proj) || proj === 'Ohne Projekt' ? 'Intern' : 'Kunde'
      c.push([date, wk, catName, proj, ticket, hm(it.seconds), dec(it.seconds)].map(cesc).join(';'))
    }
  }

  return { year: first.getFullYear(), month: first.getMonth(), key, html, csv: c.join('\n'), totalSeconds: totalWork, workDays: bookedDays }
}

export function reportCsv(dateMs: number, nowMs: number, graceSeconds: number): string {
  const segs = segments(dateMs, nowMs, graceSeconds)
  const esc2 = (v: string) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  const rows: string[] = ['Datum,Von,Bis,Art,Ticket,Notiz,Minuten']
  const day = new Date(dateMs).toLocaleDateString('sv-SE')
  for (const s of segs) {
    const art = s.kind === 'work' ? 'Arbeit' : 'Pause'
    const mins = Math.round((s.end - s.start) / 60000)
    rows.push([day, clock(s.start), clock(s.end), art, s.kind === 'work' ? (s.ticket || UNASSIGNED) : '', s.note || '', String(mins)].map(esc2).join(','))
  }
  return rows.join('\n')
}
