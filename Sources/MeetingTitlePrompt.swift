//
//  MeetingTitlePrompt.swift
//  WorkTracker
//
//  Fragt nach Ende eines spontanen Calls (ohne Kalender-Termin) nach einem
//  Titel und benennt den Meeting-Block um. Default bleibt "Meeting".
//

import SwiftUI
import AppKit

@MainActor
final class MeetingTitlePrompt {
    static let shared = MeetingTitlePrompt()
    private var window: NSWindow?

    func show(prefill: String, info: String, onSave: @escaping (String) -> Void) {
        close()
        let view = MeetingTitleView(
            prefill: prefill,
            info: info,
            onSave: { t in onSave(t); MeetingTitlePrompt.shared.close() },
            onCancel: { MeetingTitlePrompt.shared.close() })
        let hosting = NSHostingController(rootView: view)
        let win = NSWindow(contentViewController: hosting)
        win.styleMask = [.titled]
        win.title = "WorkTracker"
        win.level = .floating
        win.isReleasedWhenClosed = false
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        win.setContentSize(hosting.view.fittingSize)
        if let screen = NSScreen.main {
            let vf = screen.visibleFrame
            let wf = win.frame
            win.setFrameOrigin(NSPoint(x: vf.midX - wf.width / 2, y: vf.midY - wf.height / 2))
        } else {
            win.center()
        }
        NSApp.activate(ignoringOtherApps: true)
        win.makeKeyAndOrderFront(nil)
        window = win
    }

    func close() {
        window?.close()
        window = nil
    }
}

struct MeetingTitleView: View {
    let prefill: String
    let info: String
    let onSave: (String) -> Void
    let onCancel: () -> Void

    @State private var title: String
    @FocusState private var focused: Bool

    init(prefill: String, info: String,
         onSave: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
        self.prefill = prefill
        self.info = info
        self.onSave = onSave
        self.onCancel = onCancel
        _title = State(initialValue: prefill)
    }

    private func save() { onSave(title.trimmingCharacters(in: .whitespaces).isEmpty ? "Meeting" : title) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: "person.2.fill")
                    .font(.system(size: 28)).foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Meeting beendet").font(.headline)
                    Text(info).font(.callout).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            TextField("Titel des Calls", text: $title)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit { save() }

            Divider()
            HStack {
                Spacer()
                Button("Als „Meeting“ lassen") { onCancel() }
                    .keyboardShortcut(.cancelAction)
                Button("Speichern") { save() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 400)
        .onAppear { focused = true }
    }
}
