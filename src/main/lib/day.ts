// Ableitung der Tages-Segmente aus Roh-Events (portiert aus Swift DayModel).

import { randomUUID } from 'node:crypto'
import { WTEvent, Segment, DaySummary, UNASSIGNED } from './types'
import { loadEvents, isMaterialized, loadStoredSegments, dayKey, isDayEnded } from './store'

const HOUR = 3600_000
const MIN = 60_000

function startOfDay(ms: number): number {
  const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime()
}
function endOfDay(ms: number): number {
  return startOfDay(ms) + 24 * HOUR
}
function isToday(ms: number): boolean {
  return dayKey(ms) === dayKey(Date.now())
}

export function deriveSegments(dateMs: number, nowMs: number, graceSeconds: number): Segment[] {
  const events = loadEvents(dateMs)
  if (!events.length) return []

  const isActiveStart = (t: string) => t === 'active'
  const isActiveEnd = (t: string) => t === 'inactive' || t === 'appStop'

  const lastTs = events[events.length - 1].ts
  const liveCap = Math.min(nowMs, endOfDay(dateMs), lastTs + graceSeconds * 1000)

  // Arbeitsintervalle aus .active -> .inactive/.appStop. endType merkt sich,
  // ob das Intervall durch echtes Inaktiv (Pause) oder App-Beendigung endete.
  type Iv = { a: number; b: number; endType: 'inactive' | 'appStop' | 'live' }
  const raw: Iv[] = []
  let activeSince: number | null = null
  for (const ev of events) {
    if (isActiveStart(ev.type)) {
      if (activeSince === null) activeSince = ev.ts
    } else if (isActiveEnd(ev.type)) {
      if (activeSince !== null) {
        if (ev.ts > activeSince) raw.push({ a: activeSince, b: ev.ts, endType: ev.type === 'appStop' ? 'appStop' : 'inactive' })
        activeSince = null
      }
    }
  }
  if (activeSince !== null && liveCap > activeSince) raw.push({ a: activeSince, b: liveCap, endType: 'live' })
  if (!raw.length) return []

  // Lücken zusammenfassen:
  //  - sehr kurze Lücken (< 2 min) immer (kurze Hänger),
  //  - Lücken nach App-Beendigung (App war aus, nicht der Nutzer in Pause) bis 30 min.
  // Echte Inaktiv-Pausen (Idle/Sperren) bleiben als Pause erhalten.
  const MERGE_GAP = 2 * MIN
  const APP_DOWN_CAP = 30 * MIN
  const mergedIv: Iv[] = []
  for (const iv of raw) {
    const last = mergedIv[mergedIv.length - 1]
    const gap = last ? iv.a - last.b : Infinity
    const mergeable = !!last && (gap < MERGE_GAP || (last.endType === 'appStop' && gap < APP_DOWN_CAP))
    if (mergeable) { last.b = Math.max(last.b, iv.b); last.endType = iv.endType }
    else mergedIv.push({ ...iv })
  }
  const intervals: Array<[number, number]> = mergedIv.map(iv => [iv.a, iv.b])

  const samples = events.filter(e => e.type === 'sample')

  const ticketFor = (a: number, b: number): string | null => {
    const counts: Record<string, number> = {}
    for (const ev of samples) {
      if (ev.ts < a || ev.ts > b || ev.call) continue
      if (ev.ticket) counts[ev.ticket] = (counts[ev.ticket] || 0) + 1
    }
    let best: string | null = null, n = 0
    for (const k in counts) if (counts[k] > n) { n = counts[k]; best = k }
    return best
  }
  const meetingTitle = (a: number, b: number): string => {
    const counts: Record<string, number> = {}
    for (const ev of samples) {
      if (ev.ts < a || ev.ts > b) continue
      if (ev.call && ev.call !== 'Meeting') counts[ev.call] = (counts[ev.call] || 0) + 1
    }
    let best = 'Meeting', n = 0
    for (const k in counts) if (counts[k] > n) { n = counts[k]; best = k }
    return best
  }
  const repoFor = (a: number, b: number): string | null => {
    const counts: Record<string, number> = {}
    for (const ev of samples) {
      if (ev.ts < a || ev.ts > b || ev.call) continue
      if (ev.repo) counts[ev.repo] = (counts[ev.repo] || 0) + 1
    }
    let best: string | null = null, n = 0
    for (const k in counts) if (counts[k] > n) { n = counts[k]; best = k }
    return best
  }
  const mkSeg = (a: number, b: number, inCall: boolean): Segment => ({
    id: randomUUID(),
    start: a, end: b, kind: 'work',
    ticket: inCall ? meetingTitle(a, b) : ticketFor(a, b),
    project: inCall ? null : repoFor(a, b),
    meeting: inCall || undefined,
    note: null, source: 'auto'
  })

  // Ein Intervall nach im-Call/nicht-im-Call splitten.
  const workSegments = (start: number, end: number): Segment[] => {
    const inRange = samples.filter(e => e.ts >= start && e.ts <= end)
    if (!inRange.length) return [mkSeg(start, end, false)]
    const subs: Segment[] = []
    let segStart = start
    let inCall = !!inRange[0].call
    for (const ev of inRange) {
      const evInCall = !!ev.call
      if (evInCall !== inCall) {
        if (ev.ts > segStart) subs.push(mkSeg(segStart, ev.ts, inCall))
        segStart = ev.ts; inCall = evInCall
      }
    }
    if (end > segStart) subs.push(mkSeg(segStart, end, inCall))
    return subs
  }

  const segs: Segment[] = []
  for (let i = 0; i < intervals.length; i++) {
    segs.push(...workSegments(intervals[i][0], intervals[i][1]))
    if (i + 1 < intervals.length) {
      const gs = intervals[i][1], ge = intervals[i + 1][0]
      if (ge > gs) segs.push({ id: randomUUID(), start: gs, end: ge, kind: 'break', source: 'auto' })
    }
  }

  // Laufende Pause heute sichtbar machen – ABER nur bei einer echten Idle-/Sperr-Pause
  // INNERHALB einer laufenden Sitzung ('tick'/'lock'). Nach einem expliziten Stopp
  // (Privat/Pause/Feierabend/Standby) wird nichts angehängt = es läuft einfach nichts.
  if (isToday(dateMs) && activeSince === null) {
    const lastWorkEnd = intervals[intervals.length - 1][1]
    const lastState = [...events].reverse().find(e => e.type === 'active' || e.type === 'inactive')
    if (lastState && lastState.type === 'inactive' && (lastState.reason === 'tick' || lastState.reason === 'lock')) {
      const cap = Math.min(nowMs, endOfDay(dateMs))
      if (cap > lastWorkEnd) segs.push({ id: randomUUID(), start: lastWorkEnd, end: cap, kind: 'break', source: 'auto' })
    }
  }
  return segs
}

function identity(s: Segment): string {
  // Meeting/Projekt/Ticket/Notiz – verhindert das Verschmelzen verschieden
  // gefärbter oder benannter Blöcke.
  return [s.meeting ? 'M' : '', s.project || '', s.ticket || '', s.note || ''].join('|')
}

function coalesce(segs: Segment[]): Segment[] {
  const sorted = [...segs].sort((a, b) => a.start - b.start)
  const out: Segment[] = []
  for (const s of sorted) {
    const last = out[out.length - 1]
    if (last && last.kind === 'work' && s.kind === 'work' &&
        identity(last) === identity(s) && s.start <= last.end + 1000) {
      last.end = Math.max(last.end, s.end)
    } else {
      out.push({ ...s })
    }
  }
  return out
}

function clipOverlaps(segs: Segment[]): Segment[] {
  const out: Segment[] = []
  let lastEnd: number | null = null
  for (const s0 of [...segs].sort((a, b) => a.start - b.start)) {
    const s = { ...s0 }
    if (lastEnd !== null && s.start < lastEnd) s.start = lastEnd
    if (s.end > s.start) { out.push(s); lastEnd = s.end }
  }
  return out
}

export function segments(dateMs: number, nowMs: number, graceSeconds: number): Segment[] {
  if (isMaterialized(dateMs)) {
    const stored = loadStoredSegments(dateMs)
    if (stored) {
      // Vergangene Tage ODER Feierabend (Tag beendet): exakt das Gespeicherte (statisch).
      if (!isToday(dateMs) || isDayEnded(dateMs)) return clipOverlaps(coalesce(stored))
      // HEUTE: kuratierte Blöcke fix, aber der laufende Teil wächst weiter.
      // Die Live-Fortsetzung wird auf GENERISCHE Arbeit reduziert (kein
      // Auto-Ticket/Projekt), damit sie sauber mit dem letzten generischen
      // Arbeitsblock verschmilzt ("letzter Eintrag wächst") statt als separater
      // kleiner Block aufzutauchen. Echte Pausen (Idle/Sperren) bleiben erhalten.
      const cutoff = stored.reduce((m, s) => Math.max(m, s.end), startOfDay(dateMs))
      const tail: Segment[] = []
      for (const s of deriveSegments(dateMs, nowMs, graceSeconds)) {
        if (s.end <= cutoff) continue
        const seg: Segment = { ...s, start: Math.max(s.start, cutoff) }
        if (seg.kind === 'work') { seg.ticket = null; seg.note = null; seg.project = null; seg.meeting = undefined }
        tail.push(seg)
      }
      return clipOverlaps(coalesce([...stored, ...tail]))
    }
  }
  return clipOverlaps(coalesce(deriveSegments(dateMs, nowMs, graceSeconds)))
}

export function summary(dateMs: number, nowMs: number, graceSeconds: number): DaySummary {
  const segs = segments(dateMs, nowMs, graceSeconds)
  const work = segs.filter(s => s.kind === 'work')
  const breaks = segs.filter(s => s.kind === 'break')
  const dur = (s: Segment) => Math.max(0, s.end - s.start)
  return {
    date: dateMs,
    start: segs.length ? Math.min(...segs.map(s => s.start)) : undefined,
    end: segs.length ? Math.max(...segs.map(s => s.end)) : undefined,
    workedSeconds: work.reduce((a, s) => a + dur(s), 0) / 1000,
    breakSeconds: breaks.reduce((a, s) => a + dur(s), 0) / 1000,
    segments: segs,
    materialized: isMaterialized(dateMs)
  }
}

export function ticketTotals(dateMs: number, nowMs: number, graceSeconds: number): Array<{ ticket: string, seconds: number }> {
  const work = segments(dateMs, nowMs, graceSeconds).filter(s => s.kind === 'work')
  const map: Record<string, number> = {}
  for (const s of work) {
    const k = s.ticket || UNASSIGNED
    map[k] = (map[k] || 0) + Math.max(0, s.end - s.start) / 1000
  }
  return Object.entries(map).map(([ticket, seconds]) => ({ ticket, seconds })).sort((a, b) => b.seconds - a.seconds)
}
