import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { Popup } from './Popup'
import './index.css'

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: '-apple-system, sans-serif', color: 'var(--text)' }}>
          <h2 style={{ fontSize: 15 }}>Etwas ist schiefgelaufen</h2>
          <p style={{ fontSize: 13, color: 'var(--muted)' }}>{String(this.state.error?.message || this.state.error)}</p>
          <button style={{ fontSize: 13, padding: '6px 14px', borderRadius: 8 }} onClick={() => location.reload()}>Neu laden</button>
        </div>
      )
    }
    return this.props.children
  }
}

const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
const popupKind = hash.get('popup')
const initialView = hash.get('view') || undefined

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      {popupKind
        ? <Popup kind={popupKind} from={Number(hash.get('from')) || 0} to={Number(hash.get('to')) || 0} />
        : <App initialView={initialView} />}
    </ErrorBoundary>
  </React.StrictMode>
)
