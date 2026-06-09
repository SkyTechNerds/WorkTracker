// Überstundenkonto: Saldo aus gearbeiteten Stunden vs. Tagesziel (portiert aus Swift).

import { AppConfig } from './types'
import { summary } from './day'
import { earliestDay } from './store'

export interface OvertimeDay { date: number; workedHours: number; targetHours: number; deltaHours: number; isWorkday: boolean }
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
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const dateMs = d.getTime()
    const s = summary(dateMs, nowMs, graceSeconds)
    const workedHours = s.workedSeconds / 3600
    const wd = isWorkday(d, config.workdayWeekdays)
    const target = wd ? config.targetHoursPerDay : 0
    const delta = workedHours - target
    // Tage ganz ohne Arbeit an Arbeitstagen (z. B. Urlaub) nicht als Minus werten,
    // wenn gar keine Events existieren -> nur zählen, wenn etwas getrackt wurde.
    if (workedHours <= 0 && wd) continue
    balance += delta
    days.push({ date: dateMs, workedHours, targetHours: target, deltaHours: delta, isWorkday: wd })
  }
  return { balanceHours: balance, days }
}
