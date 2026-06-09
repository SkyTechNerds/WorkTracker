// Kompakte Popup-Fenster: Arbeit/Pause-Abfrage bei Aktivierung + Meeting-Titel
// nach spontanem Call. Eigener Render-Pfad (kein voller App-Chrome).

import { useState } from 'react'
import { Icon } from './icons'

function clock(ms: number): string {
  const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function Popup({ kind, from, to }: { kind: string; from: number; to: number }) {
  if (kind === 'meeting') return <MeetingPopup from={from} to={to} />
  return <PromptPopup />
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

function MeetingPopup({ from, to }: { from: number; to: number }) {
  const [title, setTitle] = useState('')
  const submit = () => window.wt.popupResult('meeting', title.trim() || 'Meeting')
  return (
    <div className="popup">
      <h2>Meeting beendet</h2>
      <p className="sub">{clock(from)}–{clock(to)} · Titel vergeben (optional)</p>
      <input autoFocus value={title} placeholder="z. B. Daily, Sprint Review…"
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') submit() }} />
      <button className="link-danger" onClick={() => window.wt.popupResult('meeting', '__none__')}>
        War kein Meeting – als normale Arbeitszeit zählen
      </button>
      <div className="popup-actions">
        <button onClick={() => window.wt.popupResult('meeting', 'Meeting')}>Überspringen</button>
        <span style={{ flex: 1 }} />
        <button className="primary" onClick={submit}>Übernehmen</button>
      </div>
    </div>
  )
}
