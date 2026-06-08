//
//  PromptWindow.swift
//  WorkTracker
//
//  Schwebendes Popup-Fenster, das beim Arbeitsbeginn nachfragt, ob die Zeit als
//  Arbeit zaehlen soll (z. B. wenn der Laptop ausserhalb der Arbeitszeit
//  geoeffnet wird). Bewusst als echtes Fenster (nicht Notification), damit die
//  Auswahl klar und sofort sichtbar ist.
//

import SwiftUI
import AppKit

struct WorkPromptAction: Identifiable {
    let id = UUID()
    let title: String
    let prominent: Bool
    let handler: () -> Void
}

@MainActor
final class WorkPrompt {
    static let shared = WorkPrompt()
    private var window: NSWindow?

    var isShowing: Bool { window != nil }

    func show(title: String, message: String, actions: [WorkPromptAction]) {
        close()
        // Handler so umhuellen, dass das Fenster danach schliesst.
        let wrapped = actions.map { a in
            WorkPromptAction(title: a.title, prominent: a.prominent) {
                a.handler()
                WorkPrompt.shared.close()
            }
        }
        let view = WorkPromptView(title: title, message: message, actions: wrapped)
        let hosting = NSHostingController(rootView: view)
        let win = NSWindow(contentViewController: hosting)
        win.styleMask = [.titled]
        win.title = "WorkTracker"
        win.level = .floating
        win.isReleasedWhenClosed = false
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        // Erst die tatsaechliche Content-Groesse setzen, DANN exakt auf der
        // Bildschirmmitte positionieren (sonst zentriert center() ein noch
        // ungelayoutetes Fenster und es wandert nach rechts/unten).
        win.setContentSize(hosting.view.fittingSize)
        if let screen = NSScreen.main {
            let vf = screen.visibleFrame
            let wf = win.frame
            win.setFrameOrigin(NSPoint(x: vf.midX - wf.width / 2,
                                       y: vf.midY - wf.height / 2))
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

struct WorkPromptView: View {
    let title: String
    let message: String
    let actions: [WorkPromptAction]

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: "briefcase.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(.tint)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.headline)
                    Text(message)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack(spacing: 10) {
                Spacer()
                ForEach(actions) { action in
                    if action.prominent {
                        Button(action.title) { action.handler() }
                            .buttonStyle(.borderedProminent)
                            .keyboardShortcut(.defaultAction)
                    } else {
                        Button(action.title) { action.handler() }
                            .buttonStyle(.bordered)
                    }
                }
            }
        }
        .padding(22)
        .frame(width: 400)
    }
}
