// Liest den Titel eines gerade laufenden Termins aus dem Kalender (macOS).
// Erst Apple Kalender, dann Outlook (Mac) – beide nur, wenn die App schon
// läuft (kein ungewolltes Starten). Per AppleScript via osascript; benötigt
// einmalig die Automatisierungs-Freigabe (TCC). Fehler -> null (still).

import { execFile } from 'node:child_process'
import { platform } from 'node:os'

function runOsa(script: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: timeoutMs }, (err, stdout) => {
      if (err) return resolve('')
      resolve((stdout || '').trim())
    })
  })
}

// Apple Kalender: über alle Kalender den ersten gerade laufenden Termin.
const APPLE_SCRIPT = `
if application "Calendar" is running then
  set nowDate to current date
  tell application "Calendar"
    repeat with c in calendars
      try
        set evs to (every event of c whose start date is less than or equal to nowDate and end date is greater than or equal to nowDate)
        if (count of evs) > 0 then return summary of item 1 of evs
      end try
    end repeat
  end tell
end if
return ""
`.trim()

// Outlook (Mac): gerade laufender Kalendertermin.
const OUTLOOK_SCRIPT = `
if application "Microsoft Outlook" is running then
  set nowDate to current date
  tell application "Microsoft Outlook"
    try
      set evs to (every calendar event whose start time is less than or equal to nowDate and end time is greater than or equal to nowDate)
      if (count of evs) > 0 then return subject of item 1 of evs
    end try
  end tell
end if
return ""
`.trim()

/** Titel des aktuell laufenden Termins (Apple Kalender, sonst Outlook) oder null. */
export async function currentMeetingTitle(): Promise<string | null> {
  if (platform() !== 'darwin') return null // Windows/Outlook-Graph: später
  const apple = await runOsa(APPLE_SCRIPT)
  if (apple) return apple
  const outlook = await runOsa(OUTLOOK_SCRIPT)
  if (outlook) return outlook
  return null
}
