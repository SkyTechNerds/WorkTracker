// Update-Prüfung gegen GitHub Releases (portiert aus Swift Updater).
// Kein Auto-Download – meldet nur neuere Version + Release-URL.

import { net } from 'electron'

const REPO = 'SkyTechNerds/WorkTracker'

export interface UpdateInfo {
  available: boolean
  current: string
  latest?: string
  url?: string
  notes?: string
}

function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  const pb = b.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, headers: { 'User-Agent': 'WorkTracker' } as any })
    let body = ''
    req.on('response', (res) => {
      res.on('data', (c) => { body += c.toString() })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    req.end()
  })
}

export async function checkForUpdate(currentVersion: string, includeBeta = false): Promise<UpdateInfo> {
  try {
    if (includeBeta) {
      const list = await fetchJson(`https://api.github.com/repos/${REPO}/releases`)
      const rel = Array.isArray(list) ? list.find((r: any) => !r.draft) : null
      if (!rel) return { available: false, current: currentVersion }
      const latest = rel.tag_name as string
      return { available: cmpVersion(latest, currentVersion) > 0, current: currentVersion, latest, url: rel.html_url, notes: rel.body }
    }
    const rel = await fetchJson(`https://api.github.com/repos/${REPO}/releases/latest`)
    const latest = rel.tag_name as string
    if (!latest) return { available: false, current: currentVersion }
    return { available: cmpVersion(latest, currentVersion) > 0, current: currentVersion, latest, url: rel.html_url, notes: rel.body }
  } catch {
    return { available: false, current: currentVersion }
  }
}
