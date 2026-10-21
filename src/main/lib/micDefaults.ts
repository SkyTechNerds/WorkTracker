// Bundle-ID-Präfixe, deren Mikrofon-Nutzung als Call zählt (micWatch.ts).
// Eigene Datei, damit types.ts sie ohne Electron-Import nutzen kann.
export const DEFAULT_MIC_CALL_APPS = [
  'com.microsoft.teams',        // Teams (neu: com.microsoft.teams2)
  'us.zoom.',                   // Zoom
  'com.cisco.webex',            // Webex
  'Cisco-Systems.Spark',        // Webex (ältere Bundle-ID)
  'com.tinyspeck.slackmacgap',  // Slack-Huddles
  'com.apple.FaceTime',
  'com.google.Chrome',          // Browser-Meetings (Meet, Teams im Browser)
  'com.apple.Safari',
  'company.thebrowser.Browser', // Arc
  'com.microsoft.edgemac',
  'org.mozilla.firefox',
]
