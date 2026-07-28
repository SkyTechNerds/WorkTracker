// Überstundenkonto: Saldo aus gearbeiteten Stunden vs. Tagesziel (portiert aus Swift).

import { AppConfig, AbsenceType } from './types'
import { summary } from './day'
import { earliestDay, isDayEnded, getDayAbsence } from './store'

export interface OvertimeDay { date: number; workedHours: number; targetHours: number; deltaHours: number; isWorkday: boolean; pending?: boolean; absence?: AbsenceType | null }
// balanceHours = stabiler Saldo (nur abgeschlossene/vergangene Tage). Der laufende
// Tag wird erst zum Feierabend (oder beim Tageswechsel) eingerechnet -> kein -8h am Morgen.
export interface OvertimeResult { balanceHours: number; days: OvertimeDay[] }

function isWorkday(d: Date, weekdays: number[]): boolean {
  return weekdays.includes(d.getDay() + 1) // 1=So..7=Sa
}

/** Gearbeitete Sekunden in der laufenden Woche (Montag–heute, Berlin). */
export function weekWorkedSeconds(nowMs: number, graceSeconds: number): number {
  const today = new Date(nowMs); today.setHours(0, 0, 0, 0)
  const sinceMonday = (today.getDay() + 6) % 7 // Mo=0
  let total = 0
  for (let i = 0; i <= sinceMonday; i++) {
    const d = new Date(today); d.setDate(today.getDate() - (sinceMonday - i))
    total += summary(d.getTime(), nowMs, graceSeconds).workedSeconds
  }
  return total
}

/** untilMs (optional): kumuliert nur bis zu diesem Stichtag (Zeitraum-Ende), max. heute.
 *  Ohne Angabe = bis heute (aktueller Gesamt-Saldo, wie im Überstunden-Tab). */
export function computeOvertime(config: AppConfig, nowMs: number, graceSeconds: number, untilMs = nowMs): OvertimeResult {
  const first = earliestDay()
  const days: OvertimeDay[] = []
  let balance = config.overtimeStartBalanceHours || 0
  if (!first) return { balanceHours: balance, days }

  const start = new Date(first); start.setHours(0, 0, 0, 0)
  const today = new Date(nowMs); today.setHours(0, 0, 0, 0)
  const todayMs = today.getTime()
  const until = new Date(untilMs); until.setHours(0, 0, 0, 0)
  const loopEnd = Math.min(todayMs, until.getTime()) // nie über heute hinaus
  for (let d = new Date(start); d.getTime() <= loopEnd; d.setDate(d.getDate() + 1)) {
    const dateMs = d.getTime()
    const s = summary(dateMs, nowMs, graceSeconds)
    const workedHours = s.workedSeconds / 3600
    const wd = isWorkday(d, config.workdayWeekdays)
    const absence = getDayAbsence(dateMs) // Krank/Urlaub: neutraler Tag (Soll gilt als erfüllt)
    // Freizeitausgleich: das Soll bleibt bestehen und wird aus dem Überstundenkonto
    // bezahlt -> der Tag zählt wie ein leerer Arbeitstag mit vollem Minus.
    const waived = absence === 'krank' || absence === 'urlaub'
    const target = waived ? 0 : (wd ? config.targetHoursPerDay : 0)
    // Krank/Urlaub = neutral: weder Minus (kein Soll offen) noch Plus (erfasste Zeit zählt nicht).
    const delta = waived ? 0 : (workedHours - target)
    // Laufender Tag (heute, noch kein Feierabend): NICHT in den Saldo einrechnen,
    // sondern nur als „läuft" anzeigen -> kein -8h am Morgen.
    const pending = dateMs === todayMs && !isDayEnded(dateMs)
    // Leere Arbeitstage ohne Abwesenheits-Markierung nicht als Minus werten (überspringen).
    // Krank-/Urlaubstage NICHT überspringen -> sie erscheinen (mit target 0, delta = geleistet).
    // FZA-Tage ebenfalls nicht -> sonst fiele genau das Minus weg, das den Abbau abbildet.
    if (workedHours <= 0 && wd && !absence && !pending) continue
    if (!pending) balance += delta
    days.push({ date: dateMs, workedHours, targetHours: target, deltaHours: delta, isWorkday: wd, pending, absence })
  }
  return { balanceHours: balance, days }
}
