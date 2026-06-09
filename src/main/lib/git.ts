// Git-Probe (portiert aus Swift GitProbe): Branch, Ticket, Aktivität, Commits.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

function git(args: string[], cwd?: string): string {
  try {
    return execFileSync('git', cwd ? ['-C', cwd, ...args] : args, {
      encoding: 'utf8',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      timeout: 5000
    }).trim()
  } catch {
    return ''
  }
}

/** Vorgeschlagene Git-User-Emails: globale + häufigste Autoren im Repo. */
export function gitEmails(repo: string): string[] {
  const set = new Set<string>()
  const global = git(['config', '--global', 'user.email'])
  if (global) set.add(global)
  const local = git(['-C', repo, 'config', 'user.email'])
  if (local) set.add(local)
  const authors = git(['-C', repo, 'log', '--all', '--format=%ae', '-n', '500'])
  if (authors) {
    const counts: Record<string, number> = {}
    for (const e of authors.split('\n')) { const v = e.trim(); if (v) counts[v] = (counts[v] || 0) + 1 }
    Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([e]) => set.add(e))
  }
  return [...set]
}

export function currentBranch(repo: string): string | null {
  const b = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo)
  if (!b || b === 'HEAD') return null
  return b
}

export function lastActivity(repo: string): number | null {
  let latest: number | null = null
  for (const c of ['.git/index', '.git/ORIG_HEAD', '.git/HEAD']) {
    try {
      const m = fs.statSync(path.join(repo, c)).mtimeMs
      if (latest === null || m > latest) latest = m
    } catch { /* ignore */ }
  }
  return latest
}

export function ticketFromBranch(branch: string | null): string | null {
  if (!branch) return null
  const m = branch.match(/([A-Za-z]{2,})-([0-9]+)/)
  if (!m) return null
  return `${m[1].toUpperCase()}-${m[2]}`
}

export interface CommitInfo { hash: string; subject: string; date: number; email: string }

export function commitsBetween(repo: string, sinceMs: number, untilMs: number, authorEmail: string): CommitInfo[] {
  const fmt = '%H%x1f%s%x1f%cI%x1f%ae%x1e'
  const raw = git([
    'log', '--all', // alle Branches – Commits liegen oft nicht auf dem ausgecheckten Branch
    `--since=${new Date(sinceMs).toISOString()}`,
    `--until=${new Date(untilMs).toISOString()}`,
    '--no-merges', `--pretty=format:${fmt}`
  ], repo)
  if (!raw) return []
  const out: CommitInfo[] = []
  for (const record of raw.split('\x1e')) {
    const r = record.trim()
    if (!r) continue
    const f = r.split('\x1f')
    if (f.length < 4) continue
    if (authorEmail && f[3].toLowerCase() !== authorEmail.toLowerCase()) continue
    out.push({ hash: f[0].slice(0, 8), subject: f[1], date: Date.parse(f[2]), email: f[3] })
  }
  return out
}

/** Aktives Projekt = jüngste Git-Aktivität < 30 min unter den Projekten. */
export function activeProject(projects: Array<{ name: string; repoPath: string }>):
  { name: string; branch: string | null; ticket: string | null } | null {
  const recency = 30 * 60 * 1000
  let best: { name: string; when: number; repo: string } | null = null
  for (const p of projects) {
    const when = lastActivity(p.repoPath)
    if (when === null || Date.now() - when >= recency) continue
    if (!best || when > best.when) best = { name: p.name, when, repo: p.repoPath }
  }
  if (!best) return null
  const branch = currentBranch(best.repo)
  return { name: best.name, branch, ticket: ticketFromBranch(branch) }
}
