//
//  ReportWriter.swift
//  WorkTracker
//
//  Schreibt den Tagesbericht als Markdown (lesbar) und CSV (maschinenlesbar)
//  in den daily/-Ordner. Tickets/Stichworte kommen aus den heutigen Commits
//  der gepflegten Projekte.
//

import Foundation

enum ReportWriter {

    /// Erzeugt md + csv fuer einen Tag. `commitsByTicket` mappt Ticket -> Commits;
    /// `looseCommits` sind Commits ohne erkennbares Ticket (nach Repo gruppiert im Text).
    static func write(date: Date,
                      summary: DaySummary,
                      config: AppConfig,
                      dailyDir: URL) {
        let commits = gatherCommits(date: date, projects: config.projects)
        writeMarkdown(date: date, summary: summary, commits: commits, config: config, dailyDir: dailyDir)
        writeCSV(date: date, summary: summary, dailyDir: dailyDir)
    }

    // MARK: - Commits sammeln

    struct RepoCommits {
        var project: String
        var ticket: String?
        var commits: [CommitInfo]
    }

    static func gatherCommits(date: Date, projects: [Project]) -> [RepoCommits] {
        let cal = Calendar.current
        let dayStart = cal.startOfDay(for: date)
        let dayEnd = cal.date(byAdding: .day, value: 1, to: dayStart)!
        var result: [RepoCommits] = []
        for p in projects {
            let commits = GitProbe.commitsBetween(repoPath: p.repoPath, since: dayStart,
                                                  until: dayEnd, authorEmail: p.gitUserEmail)
            guard !commits.isEmpty else { continue }
            let branch = GitProbe.currentBranch(p.repoPath)
            result.append(RepoCommits(project: p.name,
                                      ticket: GitProbe.ticket(fromBranch: branch),
                                      commits: commits))
        }
        return result
    }

    // MARK: - Markdown

    static func writeMarkdown(date: Date, summary: DaySummary,
                              commits: [RepoCommits], config: AppConfig, dailyDir: URL) {
        var md = "# Arbeitsbericht \(Fmt.dayKey(date))\n\n"

        let r = config.roundingMinutes
        let startStr = summary.start.map(Fmt.clock) ?? "–"
        let endStr = summary.end.map(Fmt.clock) ?? "–"
        md += "**Arbeitszeit:** \(startStr) – \(endStr)  \n"
        md += "**Gearbeitet:** \(Fmt.hm(summary.workedSeconds, roundTo: r))"
        if r > 0 { md += " _(gerundet auf \(r) min)_" }
        md += "  \n"
        md += "**Pause:** \(Fmt.hm(summary.breakSeconds))"
        if summary.breakSeconds > Double(config.breakCapMinutes) * 60 {
            md += "  ⚠️ über \(config.breakCapMinutes) min"
        }
        md += "  \n"
        if summary.materialized { md += "_(manuell korrigiert)_  \n" }
        md += "\n"

        // Zeit je Ticket
        let work = summary.segments.filter { $0.kind == .work }
        if !work.isEmpty {
            var perTicket: [String: TimeInterval] = [:]
            var noteFor: [String: [String]] = [:]
            for s in work {
                let key = s.ticket ?? "Ohne Ticket"
                perTicket[key, default: 0] += s.duration
                if let n = s.note, !n.isEmpty { noteFor[key, default: []].append(n) }
            }
            md += "## Zeit je Ticket\n\n"
            for (ticket, secs) in perTicket.sorted(by: { $0.value > $1.value }) {
                md += "- **\(ticket)**: \(Fmt.hm(secs, roundTo: r))"
                if let notes = noteFor[ticket], !notes.isEmpty {
                    md += " — \(Array(Set(notes)).joined(separator: "; "))"
                }
                md += "\n"
            }
            md += "\n"
        }

        // Timeline
        md += "## Zeitachse\n\n"
        if summary.segments.isEmpty {
            md += "_keine Daten_\n\n"
        } else {
            for seg in summary.segments {
                let range = "\(Fmt.clock(seg.start))–\(Fmt.clock(seg.end))"
                let dur = Fmt.hm(seg.duration)
                if seg.kind == .work {
                    let label = seg.ticket ?? "Arbeit"
                    var line = "- `\(range)` (\(dur)) **\(label)**"
                    if let n = seg.note, !n.isEmpty { line += " — \(n)" }
                    if seg.source == .manual { line += "  _(manuell)_" }
                    md += line + "\n"
                } else {
                    md += "- `\(range)` (\(dur)) _Pause_\n"
                }
            }
            md += "\n"
        }

        // Tickets / Stichworte aus Commits
        if !commits.isEmpty {
            md += "## Tickets & Tätigkeit (heutige Commits)\n\n"
            for rc in commits {
                let head = rc.ticket.map { "\($0) · \(rc.project)" } ?? rc.project
                md += "### \(head)\n"
                for c in rc.commits {
                    md += "- \(c.subject) `\(c.hash)`\n"
                }
                md += "\n"
            }
        }

        let url = dailyDir.appendingPathComponent("\(Fmt.dayKey(date)).md")
        try? md.write(to: url, atomically: true, encoding: .utf8)
    }

    // MARK: - CSV

    static func writeCSV(date: Date, summary: DaySummary, dailyDir: URL) {
        var csv = "date,start,end,kind,ticket,note,minutes,source\n"
        let day = Fmt.dayKey(date)
        for seg in summary.segments {
            let kind = seg.kind == .work ? "work" : "break"
            let ticket = csvEscape(seg.ticket ?? "")
            let note = csvEscape(seg.note ?? "")
            let minutes = String(format: "%.1f", seg.duration / 60)
            csv += "\(day),\(Fmt.clock(seg.start)),\(Fmt.clock(seg.end)),\(kind),\(ticket),\(note),\(minutes),\(seg.source.rawValue)\n"
        }
        let url = dailyDir.appendingPathComponent("\(day).csv")
        try? csv.write(to: url, atomically: true, encoding: .utf8)
    }

    static func csvEscape(_ s: String) -> String {
        if s.contains(",") || s.contains("\"") || s.contains("\n") {
            return "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        return s
    }
}
