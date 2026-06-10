// Kompakte Popup-Fenster: Arbeit/Pause-Abfrage bei Aktivierung + Meeting-Titel
// nach spontanem Call. Eigener Render-Pfad (kein voller App-Chrome).

import { useState, useEffect } from 'react'
import { Icon } from './icons'

function clock(ms: number): string {
  const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function Popup({ kind, from, to, title }: { kind: string; from: number; to: number; title?: string }) {
  if (kind === 'meeting') return <MeetingPopup from={from} to={to} suggested={title || ''} />
  if (kind === 'name') return <NamePopup />
  if (kind === 'tenhour') return <TenHourPopup hours={title || '10'} />
  return <PromptPopup />
}

function TenHourPopup({ hours }: { hours: string }) {
  return (
    <div className="popup">
      <h2>⏱ {hours}-Stunden-Grenze erreicht</h2>
      <p className="sub">Du hast heute <b>{hours} h</b> gearbeitet — die gesetzliche Tagesobergrenze (Arbeitszeitgesetz §3). Weitermachen oder Feierabend?</p>
      <div className="popup-actions">
        <button onClick={() => window.wt.popupResult('tenhour', 'weiter')}>Weitermachen</button>
        <span style={{ flex: 1 }} />
        <button className="primary" onClick={() => window.wt.popupResult('tenhour', 'feierabend')}><Icon name="moon" size={15} /> Feierabend</button>
      </div>
    </div>
  )
}

function NamePopup() {
  const [name, setName] = useState('')
  const submit = () => window.wt.popupResult('name', name.trim())
  return (
    <div className="popup">
      <h2>Willkommen 👋</h2>
      <p className="sub">Wie heißt du? Der Name erscheint im Monatsbericht (für Projektmanager).</p>
      <input autoFocus value={name} placeholder="z. B. Max Mustermann"
        onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && name.trim()) submit() }} />
      <div className="popup-actions">
        <button onClick={() => window.wt.popupResult('name', '')}>Später</button>
        <span style={{ flex: 1 }} />
        <button className="primary" onClick={submit} disabled={!name.trim()}>Speichern</button>
      </div>
    </div>
  )
}

function PromptPopup() {
  const pick = (v: string) => window.wt.popupResult('prompt', v)
  return (
    <div className="popup">
      <h2>Womit geht's weiter?</h2>
      <p className="sub">Wie soll die folgende Zeit erfasst werden?</p>
      <div className="popup-actions">
        <button className="primary" onClick={() => pick('arbeit')}><Icon name="briefcase" size={15} /> Arbeit</button>
        <button onClick={() => pick('pause')}><Icon name="coffee" size={15} /> Pause</button>
        <button onClick={() => pick('privat')}><Icon name="home" size={15} /> Privat</button>
      </div>
    </div>
  )
}

function MeetingPopup({ from, to, suggested }: { from: number; to: number; suggested: string }) {
  const [title, setTitle] = useState(suggested)
  const [f, setF] = useState(clock(from))
  const [t, setT] = useState(clock(to))
  const [project, setProject] = useState('')
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  useEffect(() => { window.wt.getConfig().then((c: any) => setProjects(c?.projects || [])) }, [])
  const payload = () => ({ from: f, to: t, project })
  const submit = () => window.wt.popupResult('meeting', title.trim() || 'Meeting', payload())
  return (
    <div className="popup">
      <h2>Meeting beendet</h2>
      <p className="sub">{suggested ? 'Titel aus dem Kalender übernommen – prüfen/anpassen' : 'Zeitraum + Titel + Kunde prüfen'}</p>
      <div className="popup-times">
        <label>Von <input type="time" value={f} onChange={e => setF(e.target.value)} /></label>
        <label>Bis <input type="time" value={t} onChange={e => setT(e.target.value)} /></label>
      </div>
      <input autoFocus value={title} placeholder="z. B. Daily, Sprint Review…"
        onFocus={e => e.target.select()}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit() }} />
      {projects.length > 0 && <select className="popup-project" value={project} onChange={e => setProject(e.target.value)}>
        <option value="">– Kunde / Projekt (für Abrechnung) –</option>
        {projects.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}
      </select>}
      <button className="link-danger" onClick={() => window.wt.popupResult('meeting', '__none__', payload())}>
        War kein Meeting – als normale Arbeitszeit zählen
      </button>
      <div className="popup-actions">
        <button onClick={() => window.wt.popupResult('meeting', 'Meeting', payload())}>Überspringen</button>
        <span style={{ flex: 1 }} />
        <button className="primary" onClick={submit}>Übernehmen</button>
      </div>
    </div>
  )
}
