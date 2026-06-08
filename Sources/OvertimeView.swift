//
//  OvertimeView.swift
//  WorkTracker
//
//  Überstunden-Konto: Gesamtsaldo + Tagesliste (Soll/Ist/Saldo). Pro Tag lässt
//  sich der Typ setzen (Urlaub/Feiertag/Krank/Freizeitausgleich); ein freier Tag
//  bzw. Freizeitausgleich zieht Überstunden ab.
//

import SwiftUI
import AppKit

struct OvertimeView: View {
    @ObservedObject var tracker: Tracker
    @ObservedObject var store: OvertimeStore
    @EnvironmentObject var configStore: ConfigStore

    @State private var editing: OvertimeRow?

    private var dayStore: DayStore { tracker.dayStore }
    private let cal = Calendar(identifier: .gregorian)

    private var range: (from: Date, to: Date) {
        let today = cal.startOfDay(for: Date())
        var from = tracker.eventStore.earliestDay() ?? today
        // Sicherheits-Cap: maximal ~13 Monate zurück.
        if let cap = cal.date(byAdding: .day, value: -400, to: today), from < cap { from = cap }
        return (cal.startOfDay(for: from), today)
    }

    private var rows: [OvertimeRow] {
        let r = range
        return Overtime.rows(dayStore: dayStore, config: configStore.config,
                             store: store, from: r.from, to: r.to)
    }

    var body: some View {
        let allRows = rows
        let total = Overtime.total(allRows, startBalance: configStore.config.overtimeStartBalanceHours)
        VStack(spacing: 0) {
            header(total: total)
            Divider()
            table(allRows.reversed())
        }
        .frame(minWidth: 560, minHeight: 520)
        .navigationTitle("Überstunden")
        .sheet(item: $editing) { row in
            DayTypeEditView(
                row: row,
                defaultHours: configStore.config.targetHoursPerDay,
                onSave: { type, hours in store.set(row.date, type: type, hours: hours) })
        }
    }

    private func header(total: Double) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 20) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Saldo")
                    .font(.caption).foregroundStyle(.secondary)
                Text(Fmt.signedHM(hours: total))
                    .font(.system(size: 30, weight: .semibold, design: .rounded))
                    .foregroundStyle(total < 0 ? .red : .green)
                    .monospacedDigit()
            }
            VStack(alignment: .leading, spacing: 2) {
                Text("Soll: \(Fmt.hours1(configStore.config.targetHoursPerDay))/Tag")
                Text("Startsaldo: \(Fmt.signedHM(hours: configStore.config.overtimeStartBalanceHours))")
            }
            .font(.callout).foregroundStyle(.secondary)
            Spacer()
            Text("Tag anklicken → Urlaub/Feiertag/Krank/Freizeit setzen")
                .font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: 180, alignment: .trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
    }

    private func table(_ rows: [OvertimeRow]) -> some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(rows) { row in
                    Button { editing = row } label: { rowView(row) }
                        .buttonStyle(.plain)
                    Divider()
                }
            }
        }
    }

    @ViewBuilder
    private func rowView(_ row: OvertimeRow) -> some View {
        let isToday = cal.isDateInToday(row.date)
        HStack(spacing: 12) {
            Text(Fmt.weekdayShort(row.date))
                .frame(width: 92, alignment: .leading)
                .foregroundStyle(Overtime.isWorkday(row.date, configStore.config) ? .primary : .secondary)
            // Typ-Badge
            if row.type != .work {
                Text(row.type.label)
                    .font(.caption).padding(.horizontal, 6).padding(.vertical, 2)
                    .background(.quaternary, in: Capsule())
            } else if isToday {
                Text("heute").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text("Soll \(Fmt.hours1(row.target))").foregroundStyle(.secondary)
                .frame(width: 90, alignment: .trailing)
            Text("Ist \(Fmt.hours1(row.worked))")
                .frame(width: 90, alignment: .trailing)
            if row.consumed > 0 {
                Text("−\(Fmt.hours1(row.consumed)) FZA").foregroundStyle(.orange)
                    .frame(width: 110, alignment: .trailing)
            }
            Text(Fmt.signedHM(hours: row.balance))
                .monospacedDigit()
                .foregroundStyle(row.balance < 0 ? .red : (row.balance > 0 ? .green : .secondary))
                .frame(width: 90, alignment: .trailing)
        }
        .font(.callout)
        .padding(.horizontal, 16).padding(.vertical, 7)
        .contentShape(Rectangle())
    }
}

// MARK: - Tag-Typ setzen

struct DayTypeEditView: View {
    let row: OvertimeRow
    let defaultHours: Double
    let onSave: (DayType, Double?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var type: DayType
    @State private var hours: Double

    init(row: OvertimeRow, defaultHours: Double, onSave: @escaping (DayType, Double?) -> Void) {
        self.row = row
        self.defaultHours = defaultHours
        self.onSave = onSave
        _type = State(initialValue: row.type)
        _hours = State(initialValue: row.consumed > 0 ? row.consumed : defaultHours)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(Fmt.weekdayShort(row.date)).font(.headline)

            Picker("Tag-Typ", selection: $type) {
                ForEach(DayType.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.radioGroup)

            if type == .compOff {
                Stepper(value: $hours, in: 0.5...24, step: 0.5) {
                    LabeledContent("Abgezogene Stunden", value: Fmt.hours1(hours))
                }
                Text("Freier Tag / Freizeitausgleich: diese Stunden werden vom Überstunden-Saldo abgezogen.")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else if type != .work {
                Text("Zählt als 0 Soll-Stunden – der Tag belastet den Saldo nicht.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Divider()
            HStack {
                Spacer()
                Button("Abbrechen") { dismiss() }.keyboardShortcut(.cancelAction)
                Button("Sichern") {
                    let t = type, h: Double? = (type == .compOff) ? hours : nil
                    dismiss()
                    DispatchQueue.main.async { onSave(t, h) }
                }
                .buttonStyle(.borderedProminent).keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 380)
    }
}
