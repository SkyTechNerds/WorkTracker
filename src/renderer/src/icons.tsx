// Schlanke Linien-Icons (Lucide-Stil) statt Emojis – stroke = currentColor,
// damit sie sich der Textfarbe anpassen.

const PATHS: Record<string, JSX.Element> = {
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  briefcase: <><rect x="2.5" y="7" width="19" height="13" rx="2" /><path d="M16 20V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v15" /><path d="M2.5 12h19" /></>,
  coffee: <><path d="M17 8h1a3.5 3.5 0 0 1 0 7h-1" /><path d="M3 8h14v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z" /><path d="M6 2v2.5M10 2v2.5M14 2v2.5" /></>,
  phone: <path d="M21 16.5v2.5a2 2 0 0 1-2.2 2 19.5 19.5 0 0 1-8.5-3 19 19 0 0 1-6-6 19.5 19.5 0 0 1-3-8.6A2 2 0 0 1 3.3 2h2.5a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L7 9.6a16 16 0 0 0 6 6l1.1-1a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z" />,
  download: <><path d="M21 15v3.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V15" /><path d="M7.5 10 12 14.5 16.5 10" /><path d="M12 3v11.5" /></>,
  pencil: <><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /><path d="M14.5 5.5l3 3" /></>,
  home: <><path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1Z" /></>,
  update: <><circle cx="12" cy="12" r="9" /><path d="M8 12.5 12 8.5 16 12.5" /><path d="M12 16V9" /></>,
  today: <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" /></>,
  pause: <><path d="M9 5.5v13" /><path d="M15 5.5v13" /></>,
  play: <path d="M8 5.5l11 6.5-11 6.5z" />,
  moon: <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z" />,
  plus: <><path d="M12 5.5v13" /><path d="M5.5 12h13" /></>,
  chevronL: <path d="M14.5 6 9 12l5.5 6" />,
  chevronR: <path d="M9.5 6 15 12l-5.5 6" />,
  reset: <><path d="M21 12a9 9 0 0 0-9-9 9.7 9.7 0 0 0-6.7 2.7L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 9 9 9.7 9.7 0 0 0 6.7-2.7L21 16" /><path d="M16 16h5v5" /></>,
  sparkles: <><path d="M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7z" /><path d="M18.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></>,
  spinner: <path d="M21 12a9 9 0 1 1-6.2-8.6" />,
  tag: <><path d="M3 11.3 11.3 3a1.9 1.9 0 0 1 1.35-.56H19a2 2 0 0 1 2 2v6.35a1.9 1.9 0 0 1-.56 1.35L12 20.6a1.9 1.9 0 0 1-2.7 0L3 14a1.9 1.9 0 0 1 0-2.7z" /><circle cx="16.3" cy="7.7" r="1.1" fill="currentColor" stroke="none" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h3.5l2 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  activity: <path d="M3 12h4l2.5-7 5 14 2.5-7H21" />,
  users: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 5.4a3.2 3.2 0 0 1 0 5.2" /><path d="M17.5 20a5.5 5.5 0 0 0-2.6-4.7" /></>,
  scale: <><path d="M12 3v18" /><path d="M7 6.5h10" /><path d="M8 21h8" /><path d="M7 6.5 4 13a3 3 0 0 0 6 0z" /><path d="M17 6.5l3 6.5a3 3 0 0 1-6 0z" /></>,
  monitor: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  broadcast: <><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none" /><path d="M8 8a6 6 0 0 0 0 8M16 16a6 6 0 0 0 0-8M5.2 5.2a10 10 0 0 0 0 13.6M18.8 18.8a10 10 0 0 0 0-13.6" /></>,
  code: <><path d="M8.5 7 3.5 12l5 5" /><path d="M15.5 7l5 5-5 5" /></>,
  archive: <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" /><path d="M9.5 12h5" /></>,
  trash: <><path d="M4 7h16" /><path d="M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2" /><path d="M6.5 7l.8 12a1 1 0 0 0 1 1h7.4a1 1 0 0 0 1-1l.8-12" /><path d="M10 11v6M14 11v6" /></>
}

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }) {
  const p = PATHS[name]
  if (!p) return null
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink: 0, verticalAlign: 'middle' }}>
      {p}
    </svg>
  )
}
