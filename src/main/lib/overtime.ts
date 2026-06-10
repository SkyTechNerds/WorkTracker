// Überstundenkonto: Saldo aus gearbeiteten Stunden vs. Tagesziel (portiert aus Swift).

import { AppConfig } from './types'
import { summary } from './day'
import { earliestDay, isDayEnded } from './store'

export interface OvertimeDay { date: number; workedHours: number; targetHours: number; deltaHours: number; isWorkday: boolean; pending?: boolean }
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

export function computeOvertime(config: AppConfig, nowMs: number, graceSeconds: number): OvertimeResult {
  const first = earliestDay()
  const days: OvertimeDay[] = []
  let balance = config.overtimeStartBalanceHours || 0
  if (!first) return { balanceHours: balance, days }

  const start = new Date(first); start.setHours(0, 0, 0, 0)
  const today = new Date(nowMs); today.setHours(0, 0, 0, 0)
  const todayMs = today.getTime()
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const dateMs = d.getTime()
    const s = summary(dateMs, nowMs, graceSeconds)
    const workedHours = s.workedSeconds / 3600
    const wd = isWorkday(d, config.workdayWeekdays)
    const target = wd ? config.targetHoursPerDay : 0
    const delta = workedHours - target
    // Laufender Tag (heute, noch kein Feierabend): NICHT in den Saldo einrechnen,
    // sondern nur als „läuft" anzeigen -> kein -8h am Morgen.
    const pending = dateMs === todayMs && !isDayEnded(dateMs)
    // Tage ganz ohne Arbeit an Arbeitstagen (z. B. Urlaub) nicht als Minus werten.
    // Der laufende Tag wird trotzdem gezeigt (als Fortschritt), aber nie negativ gewertet.
    if (workedHours <= 0 && wd && !pending) continue
    if (!pending) balance += delta
    days.push({ date: dateMs, workedHours, targetHours: target, deltaHours: delta, isWorkday: wd, pending })
  }
  return { balanceHours: balance, days }
}
