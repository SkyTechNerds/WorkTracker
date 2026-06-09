// KI-Anbindung: ordnet Arbeitszeit-Blöcken anhand der Git-Commits des Tages
// das passende Ticket + eine kurze Aufgabe zu. Provider-agnostisch.

import { AiConfig, Project, Segment } from './types'
import { commitsBetween } from './git'

function clock(ms: number): string {
  const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function extractJson(raw: string): string {
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) return fence[1].trim()
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}')
  return a >= 0 && b > a ? raw.slice(a, b + 1) : raw
}

async function callLLM(cfg: AiConfig, system: string, user: string): Promise<string> {
  if (cfg.provider === 'gemini') {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ parts: [{ text: user }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
      })
    })
    const j: any = await res.json()
    if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`)
    return j?.candidates?.[0]?.content?.parts?.[0]?.text || ''
  }
  // OpenAI-kompatibel (OpenAI, MiniMax)
  const base = cfg.provider === 'minimax' ? 'https://api.minimax.io/v1' : 'https://api.openai.com/v1'
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model, temperature: 0.2,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_object' }
    })
  })
  const j: any = await res.json()
  if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`)
  return j?.choices?.[0]?.message?.content || ''
}

/** Verfügbare Modelle des Keys laden (für die Auswahl im Setting). */
export async function listModels(cfg: AiConfig): Promise<{ models: string[]; error?: string }> {
  if (!cfg.apiKey) return { models: [], error: 'Kein API-Key' }
  try {
    if (cfg.provider === 'gemini') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(cfg.apiKey)}&pageSize=200`)
      const j: any = await res.json()
      if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`)
      const models: string[] = (j.models || [])
        .filter((m: any) => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m: any) => String(m.name).replace(/^models\//, ''))
        .filter((n: string) => n.includes('gemini'))
      return { models: models.sort().reverse() }
    }
    const base = cfg.provider === 'minimax' ? 'https://api.minimax.io/v1' : 'https://api.openai.com/v1'
    const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } })
    const j: any = await res.json()
    if (!res.ok) throw new Error(j?.error?.message || `HTTP ${res.status}`)
    let models: string[] = (j.data || []).map((m: any) => m.id).filter(Boolean)
    if (cfg.provider === 'openai') models = models.filter((m: string) => /^(gpt|o\d)/.test(m))
    return { models: models.sort() }
  } catch (e: any) {
    return { models: [], error: String(e?.message || e) }
  }
}

/** Reiner Verbindungstest (kurzer Ping ans LLM). */
export async function testAi(cfg: AiConfig): Promise<{ ok: boolean; error?: string }> {
  if (!cfg.apiKey) return { ok: false, error: 'Kein API-Key' }
  try {
    const out = await callLLM(cfg, 'Antworte nur mit JSON.', 'Gib zurück: {"ok":true}')
    return out ? { ok: true } : { ok: false, error: 'Leere Antwort' }
  } catch (e: any) { return { ok: false, error: String(e?.message || e) } }
}

export interface AssignResult { updated: Segment[]; count: number; error?: string }

export async function assignTicketsForDay(
  cfg: AiConfig, projects: Project[], segments: Segment[], dayStartMs: number, dayEndMs: number
): Promise<AssignResult> {
  if (!cfg.enabled || !cfg.apiKey) return { updated: segments, count: 0, error: 'KI nicht konfiguriert (Einstellungen → KI)' }

  const commits: Array<{ project: string; time: string; subject: string }> = []
  for (const p of projects) {
    if (!p.repoPath) continue
    for (const c of commitsBetween(p.repoPath, dayStartMs, dayEndMs, p.gitUserEmail)) {
      commits.push({ project: p.name, time: clock(c.date), subject: c.subject })
    }
  }
  // Ticket -> Projekt (für deterministischen Fallback, falls die KI kein Projekt liefert)
  const projectNames = projects.map(p => p.name)
  const ticketProject: Record<string, string> = {}
  for (const c of commits) {
    const m = c.subject.match(/([A-Za-z]{2,})-(\d+)/)
    if (m) ticketProject[`${m[1].toUpperCase()}-${m[2]}`] = c.project
  }
  // nur echte Arbeitsblöcke (keine Pausen/Meetings)
  const blocks = segments.map((s, i) => ({ i, s })).filter(x => x.s.kind === 'work' && !x.s.meeting)
  if (!blocks.length) return { updated: segments, count: 0, error: 'keine Arbeitsblöcke an diesem Tag' }
  if (!commits.length) return { updated: segments, count: 0, error: 'keine Commits an diesem Tag (Projekte/Repos prüfen)' }

  const blocksDesc = blocks.map((b, idx) => `${idx}: ${clock(b.s.start)}–${clock(b.s.end)}`).join('\n')
  const commitsDesc = commits.map(c => `[${c.time}] (${c.project}) ${c.subject}`).join('\n')
  const system = 'Du ordnest Arbeitszeit-Blöcke den passenden Tickets zu, basierend auf Git-Commits. Antworte ausschließlich mit JSON, keine Erklärungen.'
  const user =
    `Arbeitsblöcke (Index: Zeitspanne):\n${blocksDesc}\n\n` +
    `Git-Commits (Uhrzeit, Projekt, Nachricht):\n${commitsDesc}\n\n` +
    `Verfügbare Projekte (exakte Namen): ${projectNames.join(', ')}\n\n` +
    `Ordne jedem Block anhand der zeitlichen Nähe zu den Commits zu:\n` +
    `- "ticket": das Ticket-Kürzel aus der Commit-Nachricht (z. B. "WCMS-123"); wenn unklar, leer lassen.\n` +
    `- "project": den exakten Projektnamen des passenden Commits aus der Liste oben.\n` +
    `- "note": eine aussagekräftige, konkrete Beschreibung der Tätigkeit in 6–12 Wörtern, ` +
    `abgeleitet aus dem/den Commit-Text(en) dieses Blocks (kein bloßes Ticket-Kürzel, sondern WAS gemacht wurde).\n` +
    `Format: {"assignments":[{"index":0,"ticket":"WCMS-123","project":"…","note":"…"}]}`

  let raw: string
  try { raw = await callLLM(cfg, system, user) }
  catch (e: any) { return { updated: segments, count: 0, error: String(e?.message || e) } }

  let arr: Array<{ index: number; ticket?: string; project?: string; note?: string }>
  try {
    const parsed = JSON.parse(extractJson(raw))
    arr = parsed.assignments || parsed
    if (!Array.isArray(arr)) throw new Error('kein Array')
  } catch { return { updated: segments, count: 0, error: 'KI-Antwort nicht lesbar' } }

  const byIndex = new Map<number, { ticket?: string; project?: string; note?: string }>()
  for (const a of arr) if (typeof a.index === 'number') byIndex.set(a.index, a)

  let count = 0
  const updated = segments.map((s, i) => {
    const blockIdx = blocks.findIndex(b => b.i === i)
    if (blockIdx < 0) return s
    const a = byIndex.get(blockIdx)
    if (!a) return s
    const ticket = (a.ticket || '').trim()
    const note = (a.note || '').trim()
    // Projekt: von der KI gelieferten Namen nur akzeptieren wenn gültig,
    // sonst deterministisch aus dem Ticket (Repo des Commits) ableiten.
    let project = (a.project || '').trim()
    if (project && !projectNames.includes(project)) project = ''
    if (!project && ticket && ticketProject[ticket.toUpperCase()]) project = ticketProject[ticket.toUpperCase()]
    if (!ticket && !note && !project) return s
    count++
    return {
      ...s,
      ticket: ticket || s.ticket || null,
      note: note || s.note || null,
      project: project || s.project || null,
      source: 'manual' as const
    }
  })
  return { updated, count }
}
