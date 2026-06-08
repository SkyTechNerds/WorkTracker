//
//  LLMClient.swift
//  WorkTracker
//
//  Minimaler OpenAI-kompatibler Chat-Completion-Client. Funktioniert mit
//  MiniMax, OpenAI und Gemini (OpenAI-kompatibler Endpoint) – jeweils per
//  Basis-URL + API-Key + Modell konfigurierbar.
//

import Foundation

struct LLMError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

enum LLMClient {
    static func complete(baseURL: String, apiKey: String, model: String,
                         system: String, user: String) async throws -> String {
        var base = baseURL.trimmingCharacters(in: .whitespaces)
        while base.hasSuffix("/") { base.removeLast() }
        guard !apiKey.isEmpty else { throw LLMError(message: "Kein API-Key gesetzt (Einstellungen → KI).") }
        guard let url = URL(string: base + "/chat/completions") else {
            throw LLMError(message: "Ungültige Basis-URL: \(base)")
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 60

        let body: [String: Any] = [
            "model": model,
            "temperature": 0.2,
            "messages": [
                ["role": "system", "content": system],
                ["role": "user", "content": user]
            ]
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw LLMError(message: "Keine HTTP-Antwort")
        }
        guard (200..<300).contains(http.statusCode) else {
            let txt = String(data: data, encoding: .utf8) ?? ""
            throw LLMError(message: "HTTP \(http.statusCode): \(txt.prefix(300))")
        }
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = obj["choices"] as? [[String: Any]],
              let message = choices.first?["message"] as? [String: Any],
              let content = message["content"] as? String else {
            throw LLMError(message: "Antwort nicht lesbar")
        }
        return content
    }

    /// Extrahiert ein JSON-Objekt aus einer (evtl. in ```-Bloecke verpackten)
    /// Modellantwort und liefert es als [String: String].
    static func parseJSONMap(_ text: String) -> [String: String] {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = s.range(of: "```") {
            s = String(s[r.upperBound...])
            if s.hasPrefix("json") { s.removeFirst(4) }
            if let end = s.range(of: "```") { s = String(s[..<end.lowerBound]) }
        }
        // Auf das erste { ... letzte } eingrenzen.
        if let a = s.firstIndex(of: "{"), let b = s.lastIndex(of: "}"), a < b {
            s = String(s[a...b])
        }
        guard let data = s.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        var out: [String: String] = [:]
        for (k, v) in obj { out[k] = String(describing: v) }
        return out
    }

    /// Extrahiert ein JSON-Array von Objekten aus der Modellantwort.
    static func parseJSONArray(_ text: String) -> [[String: Any]] {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let r = s.range(of: "```") {
            s = String(s[r.upperBound...])
            if s.hasPrefix("json") { s.removeFirst(4) }
            if let end = s.range(of: "```") { s = String(s[..<end.lowerBound]) }
        }
        if let a = s.firstIndex(of: "["), let b = s.lastIndex(of: "]"), a < b {
            s = String(s[a...b])
        }
        guard let data = s.data(using: .utf8),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            return []
        }
        return arr
    }
}
