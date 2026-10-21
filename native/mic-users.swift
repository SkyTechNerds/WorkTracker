// Listet die Prozesse, die gerade das Mikrofon (Audio-Eingang) benutzen.
// macOS 14+: CoreAudio-Prozessobjekte (kAudioHardwarePropertyProcessObjectList,
// kAudioProcessPropertyIsRunningInput). Braucht keine Mikrofon-Berechtigung.
// Ausgabe: eine JSON-Zeile, z. B. [{"pid":123,"bundleId":"com.microsoft.teams2"}]
import CoreAudio
import Foundation

func prop<T>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ initial: T) -> T? {
  var addr = AudioObjectPropertyAddress(mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal,
                                        mElement: kAudioObjectPropertyElementMain)
  var value = initial
  var size = UInt32(MemoryLayout<T>.size)
  let st = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(obj, &addr, 0, nil, &size, $0) }
  return st == noErr ? value : nil
}

func processObjects() -> [AudioObjectID] {
  var addr = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList,
                                        mScope: kAudioObjectPropertyScopeGlobal,
                                        mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  let sys = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(sys, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(sys, &addr, 0, nil, &size, &ids) == noErr else { return [] }
  return ids
}

var out: [[String: Any]] = []
for obj in processObjects() {
  guard let running: UInt32 = prop(obj, kAudioProcessPropertyIsRunningInput, 0), running != 0 else { continue }
  let pid: pid_t = prop(obj, kAudioProcessPropertyPID, 0) ?? -1
  var bundle = ""
  if let cf: CFString = prop(obj, kAudioProcessPropertyBundleID, "" as CFString) { bundle = cf as String }
  out.append(["pid": Int(pid), "bundleId": bundle])
}
let data = try! JSONSerialization.data(withJSONObject: out)
print(String(data: data, encoding: .utf8)!)
