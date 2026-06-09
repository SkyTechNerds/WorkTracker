import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (c: any) => ipcRenderer.invoke('save-config', c),
  getDay: (dateMs: number) => ipcRenderer.invoke('get-day', dateMs),
  getSegments: (dateMs: number) => ipcRenderer.invoke('get-segments', dateMs),
  saveSegments: (dateMs: number, segs: any) => ipcRenderer.invoke('save-segments', dateMs, segs),
  isMaterialized: (dateMs: number) => ipcRenderer.invoke('is-materialized', dateMs),
  resetDay: (dateMs: number) => ipcRenderer.invoke('reset-day', dateMs),
  status: () => ipcRenderer.invoke('status'),
  feierabend: () => ipcRenderer.invoke('feierabend'),
  resumeWork: () => ipcRenderer.invoke('resume-work'),
  pauseWork: () => ipcRenderer.invoke('pause-work'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  gitEmails: (repoPath: string) => ipcRenderer.invoke('git-emails', repoPath),
  overtime: () => ipcRenderer.invoke('overtime'),
  exportDay: (dateMs: number, format: 'md' | 'csv') => ipcRenderer.invoke('export-day', dateMs, format),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  appVersion: () => ipcRenderer.invoke('app-version'),
  popupResult: (kind: string, value: string) => ipcRenderer.invoke('popup-result', kind, value),
  mqttTest: (mq: any) => ipcRenderer.invoke('mqtt-test', mq),
  mqttStatus: () => ipcRenderer.invoke('mqtt-status'),
  aiTest: (ai: any) => ipcRenderer.invoke('ai-test', ai),
  aiModels: (ai: any) => ipcRenderer.invoke('ai-models', ai),
  aiAssignDay: (dateMs: number) => ipcRenderer.invoke('ai-assign-day', dateMs),
  exportBackup: () => ipcRenderer.invoke('export-backup'),
  importBackup: () => ipcRenderer.invoke('import-backup'),
  backupNow: () => ipcRenderer.invoke('backup-now'),
  onTick: (cb: () => void) => {
    const h = () => cb()
    ipcRenderer.on('tick', h)
    return () => ipcRenderer.removeListener('tick', h)
  },
  onNavigate: (cb: (view: string) => void) => {
    const h = (_e: any, view: string) => cb(view)
    ipcRenderer.on('navigate', h)
    return () => ipcRenderer.removeListener('navigate', h)
  },
  onUpdateAvailable: (cb: (info: any) => void) => {
    const h = (_e: any, info: any) => cb(info)
    ipcRenderer.on('update-available', h)
    return () => ipcRenderer.removeListener('update-available', h)
  }
}

contextBridge.exposeInMainWorld('wt', api)
export type WTApi = typeof api
