//
//  SettingsView.swift
//  WorkTracker
//
//  Einstellungen (⌘,): Allgemein (Output, Idle-/Sample-Parameter, Autostart)
//  und Projekte (Repo-Pfad + zugeordnete Git-Identitaet aus erkannten Usern).
//  HIG: Settings-Scene mit Tab-Toolbar, grouped Forms, Standard-Controls.
//

import SwiftUI
import AppKit
import ServiceManagement

struct SettingsView: View {
    @EnvironmentObject var configStore: ConfigStore

    var body: some View {
        TabView {
            GeneralSettingsView()
                .tabItem { Label("Allgemein", systemImage: "gearshape") }
            ProjectsSettingsView()
                .tabItem { Label("Projekte", systemImage: "folder") }
            AISettingsView()
                .tabItem { Label("KI", systemImage: "sparkles") }
        }
        .frame(width: 580, height: 440)
        .onChange(of: configStore.config) { _, _ in configStore.save() }
    }
}

// MARK: - Allgemein

struct GeneralSettingsView: View {
    @EnvironmentObject var configStore: ConfigStore

    var body: some View {
        Form {
            Section("Speicherort") {
                LabeledContent("Ordner") {
                    HStack {
                        Text(configStore.config.outputDir)
                            .truncationMode(.head).lineLimit(1)
                            .foregroundStyle(.secondary)
                        Button("Wählen…") { chooseOutput() }
                    }
                }
                Button("Im Finder zeigen") {
                    NSWorkspace.shared.open(configStore.outputURL)
                }
            }

            Section("Tracking") {
                Stepper(value: $configStore.config.idleThresholdMinutes, in: 1...60) {
                    LabeledContent("Pause ab Inaktivität",
                                   value: "\(configStore.config.idleThresholdMinutes) min")
                }
                Stepper(value: $configStore.config.sampleIntervalSeconds, in: 15...600, step: 15) {
                    LabeledContent("Aktivität abtasten alle",
                                   value: "\(configStore.config.sampleIntervalSeconds) s")
                }
                Stepper(value: $configStore.config.breakCapMinutes, in: 5...120, step: 5) {
                    LabeledContent("Pausen-Warnung ab",
                                   value: "\(configStore.config.breakCapMinutes) min")
                }
            }

            Section("Kalender-Ansicht") {
                Stepper(value: $configStore.config.workdayStartHour, in: 0...12) {
                    LabeledContent("Tag beginnt",
                                   value: String(format: "%02d:00", configStore.config.workdayStartHour))
                }
                Stepper(value: $configStore.config.workdayEndHour, in: 13...24) {
                    LabeledContent("Tag endet",
                                   value: String(format: "%02d:00", configStore.config.workdayEndHour))
                }
            }

            Section("Arbeitsbeginn") {
                Picker("Nachfragen", selection: $configStore.config.promptMode) {
                    ForEach(PromptMode.allCases) { mode in
                        Text(mode.label).tag(mode)
                    }
                }
                if configStore.config.promptMode == .afterBreaks {
                    Stepper(value: $configStore.config.promptAfterBreakMinutes, in: 5...120, step: 5) {
                        LabeledContent("Lange Pause ab",
                                       value: "\(configStore.config.promptAfterBreakMinutes) min")
                    }
                }
                Text(promptModeHint)
                    .font(.caption).foregroundStyle(.secondary)
                Toggle("Mitteilung bei neu erkanntem Ticket",
                       isOn: $configStore.config.notifyTaskStart)
            }

            Section("Buchung") {
                Picker("Zeiten runden auf", selection: $configStore.config.roundingMinutes) {
                    Text("Exakt").tag(0)
                    Text("5 min").tag(5)
                    Text("15 min").tag(15)
                    Text("30 min").tag(30)
                }
                Text("Betrifft die ausgewiesenen Summen (Tag, je Ticket, Bericht). Die Zeitachse bleibt exakt.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Darstellung") {
                Picker("Menüleisten-Icon", selection: $configStore.config.menuIcon) {
                    ForEach(MenuIconStyle.allCases) { icon in
                        Label(icon.label, systemImage: icon.active).tag(icon)
                    }
                }
            }

            Section("Start") {
                Toggle("Beim Anmelden automatisch starten",
                       isOn: Binding(
                        get: { configStore.config.startAtLogin },
                        set: { setLogin($0) }))
            }
        }
        .formStyle(.grouped)
    }

    private var promptModeHint: String {
        switch configStore.config.promptMode {
        case .off:         return "Jede aktive Zeit zählt automatisch als Arbeit – kein Popup."
        case .onceADay:    return "Fragt nur einmal täglich, beim ersten Aktivwerden."
        case .afterBreaks: return "Fragt beim ersten Aktivwerden und nach längeren Pausen. Kurze Pausen zählen automatisch weiter."
        case .everyUnlock: return "Fragt bei jeder Rückkehr aus Sperre/Pause."
        }
    }

    private func chooseOutput() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            configStore.config.outputDir = url.path
            configStore.ensureOutputDir()
        }
    }

    private func setLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() }
            else { try SMAppService.mainApp.unregister() }
            configStore.config.startAtLogin = on
        } catch {
            NSLog("WorkTracker: Login-Item konnte nicht gesetzt werden: \(error)")
        }
    }
}

// MARK: - Projekte

struct ProjectsSettingsView: View {
    @EnvironmentObject var configStore: ConfigStore
    @State private var selection: Project.ID?
    @State private var discoveredUsers: [String] = []

    var body: some View {
        HStack(spacing: 0) {
            projectList
            Divider()
            detail
        }
        .onAppear(perform: refreshUsers)
    }

    private var projectList: some View {
        VStack(spacing: 0) {
            List(selection: $selection) {
                ForEach(configStore.config.projects) { p in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(p.name.isEmpty ? "(ohne Namen)" : p.name)
                        Text(p.gitUserEmail.isEmpty ? "kein User" : p.gitUserEmail)
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    .tag(p.id)
                }
            }
            Divider()
            HStack {
                Button { addProject() } label: { Image(systemName: "plus") }
                Button { removeSelected() } label: { Image(systemName: "minus") }
                    .disabled(selection == nil)
                Spacer()
            }
            .buttonStyle(.borderless)
            .padding(6)
        }
        .frame(width: 200)
    }

    @ViewBuilder
    private var detail: some View {
        if let id = selection, let proj = binding(for: id) {
            Form {
                Section("Projekt") {
                    TextField("Name", text: proj.name)
                    LabeledContent("Repo") {
                        HStack {
                            Text(proj.wrappedValue.repoPath.isEmpty ? "—" : proj.wrappedValue.repoPath)
                                .truncationMode(.head).lineLimit(1)
                                .foregroundStyle(.secondary)
                            Button("Wählen…") { chooseRepo(proj) }
                        }
                    }
                }
                Section("Git-Identität") {
                    Picker("Dieser User zählt als „ich“", selection: proj.gitUserEmail) {
                        ForEach(userOptions(current: proj.wrappedValue.gitUserEmail), id: \.self) { u in
                            Text(u.isEmpty ? "— wählen —" : u).tag(u)
                        }
                    }
                    Button("Im System gefundene User aktualisieren") { refreshUsers() }
                        .font(.caption)
                    if let branch = currentBranch(proj.wrappedValue.repoPath) {
                        LabeledContent("Aktueller Branch", value: branch)
                        if let t = GitProbe.ticket(fromBranch: branch) {
                            LabeledContent("Erkanntes Ticket", value: t)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .frame(maxWidth: .infinity)
        } else {
            VStack {
                Spacer()
                Text("Projekt auswählen oder mit + hinzufügen")
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .frame(maxWidth: .infinity)
        }
    }

    // MARK: - Helpers

    private func binding(for id: Project.ID) -> Binding<Project>? {
        guard let idx = configStore.config.projects.firstIndex(where: { $0.id == id }) else { return nil }
        return Binding(
            get: { configStore.config.projects[idx] },
            set: { configStore.config.projects[idx] = $0; configStore.save() })
    }

    private func userOptions(current: String) -> [String] {
        var opts = discoveredUsers
        if !current.isEmpty && !opts.contains(current) { opts.insert(current, at: 0) }
        if !opts.contains("") { opts.append("") }
        return opts
    }

    private func currentBranch(_ path: String) -> String? {
        path.isEmpty ? nil : GitProbe.currentBranch(path)
    }

    private func addProject() {
        let p = Project(name: "Neues Projekt", repoPath: "",
                        gitUserEmail: discoveredUsers.first ?? "")
        configStore.config.projects.append(p)
        selection = p.id
        configStore.save()
    }

    private func removeSelected() {
        guard let id = selection else { return }
        configStore.config.projects.removeAll { $0.id == id }
        selection = nil
        configStore.save()
    }

    private func chooseRepo(_ proj: Binding<Project>) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url {
            proj.wrappedValue.repoPath = url.path
            if proj.wrappedValue.name.isEmpty || proj.wrappedValue.name == "Neues Projekt" {
                proj.wrappedValue.name = url.lastPathComponent
            }
            // Repo-eigene Identitaet vorschlagen, falls noch keine gesetzt.
            let repoEmail = GitProbe.run(["config", "user.email"], in: url.path)
            if proj.wrappedValue.gitUserEmail.isEmpty && !repoEmail.isEmpty {
                proj.wrappedValue.gitUserEmail = repoEmail
            }
            configStore.save()
            refreshUsers()
        }
    }

    private func refreshUsers() {
        let paths = configStore.config.projects.map(\.repoPath).filter { !$0.isEmpty }
        DispatchQueue.global(qos: .userInitiated).async {
            let users = GitProbe.discoverUsers(repoPaths: paths)
            DispatchQueue.main.async { self.discoveredUsers = users }
        }
    }
}

// MARK: - KI

struct AISettingsView: View {
    @EnvironmentObject var configStore: ConfigStore

    var body: some View {
        Form {
            Section {
                Toggle("KI-Tätigkeitsbeschreibung aktivieren",
                       isOn: $configStore.config.aiEnabled)
                Text("Im Kalender erzeugt der ✨-Button je Ticket aus den Git-Commits des Tages eine kurze deutsche Tätigkeitsbeschreibung und füllt damit leere Zeitblöcke.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Anbieter") {
                Menu("Vorlage wählen…") {
                    Button("MiniMax") { setProvider("https://api.minimax.io/v1", "MiniMax-Text-01") }
                    Button("OpenAI") { setProvider("https://api.openai.com/v1", "gpt-4o-mini") }
                    Button("Google Gemini") { setProvider("https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.0-flash") }
                }
                TextField("Basis-URL", text: $configStore.config.aiBaseURL)
                    .textFieldStyle(.roundedBorder)
                TextField("Modell", text: $configStore.config.aiModel)
                    .textFieldStyle(.roundedBorder)
                SecureField("API-Key", text: $configStore.config.aiApiKey)
                    .textFieldStyle(.roundedBorder)
                Text("Der Key wird lokal in der config.json gespeichert.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private func setProvider(_ url: String, _ model: String) {
        configStore.config.aiBaseURL = url
        configStore.config.aiModel = model
    }
}
