// novus-speech: the on-device hearing behind dictation (D-241).
//
// A small helper the desktop's main process spawns per take. It speaks NDJSON
// on stdout and takes framed messages on stdin, so nothing here holds a key,
// opens a socket, or writes a file: Apple's speech recognizer runs on this
// Mac with `requiresOnDeviceRecognition`, and the vocabulary rides in as
// `contextualStrings`.
//
//   novus-speech probe [--locale en-US]
//   novus-speech authorize [--locale en-US]
//   novus-speech file --path take.wav [--locale en-US] [--terms '["a","b"]']
//   novus-speech live --rate 24000 [--locale en-US] [--terms '["a","b"]']
//
// Live stdin framing: 1 byte kind, 4 bytes little-endian length, payload.
// Kind 0 is PCM16 mono audio at --rate, 1 commits the open segment (its
// final follows), 2 stops (the last final follows, then exit). Out:
//   {"kind":"ready"} {"kind":"interim","text":…} {"kind":"final","text":…}
//   {"kind":"error","message":…} {"kind":"probe",…}

import AVFoundation
import Foundation
import Speech

let outLock = NSLock()
func emit(_ object: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
  outLock.lock()
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
  outLock.unlock()
}

/** A line for the machine's log; Novus prefixes it with the helper's name. */
func warn(_ message: String) {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}

/** The words of a transcript, folded, for telling a revision from a restart. */
func wordSet(_ text: String) -> Set<String> {
  Set(text.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init))
}

/** Whether a partial result began a new utterance rather than revising the
 *  one under way: the recognizer revises by keeping most of the words, and
 *  restarts by keeping almost none of them. Short partials are never judged;
 *  a revision of a few words can replace them all. */
func restarted(from previous: String, to next: String) -> Bool {
  let before = wordSet(previous)
  guard before.count >= 4 else { return false }
  let kept = before.intersection(wordSet(next)).count
  return kept * 3 < before.count
}

func fail(_ message: String) -> Never {
  emit(["kind": "error", "message": message])
  exit(1)
}

func argument(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let at = args.firstIndex(of: name), at + 1 < args.count else { return nil }
  return args[at + 1]
}

func authorizationWord(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
  switch status {
  case .authorized: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "not_determined"
  @unknown default: return "unknown"
  }
}

func locale() -> Locale {
  if let id = argument("--locale") { return Locale(identifier: id) }
  return Locale.current
}

/// The vocabulary, as a JSON array on the command line: names only, never a
/// file on disk. The recognizer takes at most a hundred.
func contextTerms() -> [String] {
  guard let raw = argument("--terms"), let data = raw.data(using: .utf8),
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [String] else { return [] }
  return parsed.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.prefix(100).map { $0 }
}

func probe(_ recognizer: SFSpeechRecognizer?) -> [String: Any] {
  return [
    "kind": "probe",
    "authorization": authorizationWord(SFSpeechRecognizer.authorizationStatus()),
    "available": recognizer?.isAvailable ?? false,
    "onDevice": recognizer?.supportsOnDeviceRecognition ?? false,
    "locale": locale().identifier
  ]
}

/// The system's own prompt, the first time; the answer after. Pumped on the
/// main run loop, where the framework delivers it.
func authorize() {
  guard SFSpeechRecognizer.authorizationStatus() == .notDetermined else { return }
  var done = false
  SFSpeechRecognizer.requestAuthorization { _ in done = true }
  let deadline = Date().addingTimeInterval(180)
  while !done && Date() < deadline {
    RunLoop.main.run(until: Date().addingTimeInterval(0.05))
  }
}

func makeRequest<T: SFSpeechRecognitionRequest>(_ request: T, terms: [String]) -> T {
  request.requiresOnDeviceRecognition = true
  request.taskHint = .dictation
  if #available(macOS 13.0, *) { request.addsPunctuation = true }
  if !terms.isEmpty { request.contextualStrings = terms }
  return request
}

/// Int16 little-endian mono samples as the float buffer the recognizer hears.
func pcmBuffer(_ data: Data, format: AVAudioFormat) -> AVAudioPCMBuffer? {
  let count = data.count / 2
  guard count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else { return nil }
  buffer.frameLength = AVAudioFrameCount(count)
  guard let channel = buffer.floatChannelData?[0] else { return nil }
  data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
    for at in 0..<count {
      let low = UInt16(raw[at * 2])
      let high = UInt16(raw[at * 2 + 1])
      let sample = Int16(bitPattern: low | (high << 8))
      channel[at] = Float(sample) / 32768.0
    }
  }
  return buffer
}

let mode = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "probe"
let recognizer = SFSpeechRecognizer(locale: locale())

switch mode {
case "probe":
  emit(probe(recognizer))
  exit(0)

case "authorize":
  authorize()
  emit(probe(recognizer))
  exit(0)

case "file":
  guard let path = argument("--path") else { fail("file mode needs --path") }
  guard let recognizer = recognizer, recognizer.isAvailable else { fail("Speech recognition is not available for \(locale().identifier) on this Mac.") }
  guard recognizer.supportsOnDeviceRecognition else { fail("On-device recognition is not available for \(locale().identifier): enable Dictation for it under System Settings → Keyboard.") }
  let request = makeRequest(SFSpeechURLRecognitionRequest(url: URL(fileURLWithPath: path)), terms: contextTerms())
  request.shouldReportPartialResults = false
  var finished = false
  recognizer.recognitionTask(with: request) { result, error in
    if let result = result, result.isFinal {
      emit(["kind": "final", "text": result.bestTranscription.formattedString])
      finished = true
      return
    }
    if let error = error {
      emit(["kind": "error", "message": error.localizedDescription])
      finished = true
    }
  }
  let deadline = Date().addingTimeInterval(600)
  while !finished && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
  exit(finished ? 0 : 2)

case "live":
  guard let recognizer = recognizer, recognizer.isAvailable else { fail("Speech recognition is not available for \(locale().identifier) on this Mac.") }
  guard recognizer.supportsOnDeviceRecognition else { fail("On-device recognition is not available for \(locale().identifier): enable Dictation for it under System Settings → Keyboard.") }
  let rate = Double(argument("--rate") ?? "24000") ?? 24000
  guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false) else { fail("Unsupported audio format.") }
  let terms = contextTerms()
  let state = DispatchQueue(label: "novus.speech.state")
  // One recognition request at a time: the on-device recognizer cancels a
  // task when a second one starts, so the next segment's request opens only
  // once the ended one has answered, and the frames that arrive meanwhile
  // wait in `pending` (bounded to about half a minute of audio).
  var request: SFSpeechAudioBufferRecognitionRequest? = nil
  var pending: [AVAudioPCMBuffer] = []
  var pendingFrames: AVAudioFrameCount = 0
  var generation = 0
  var waitingForAnswer = false
  var stopping = false
  var exiting = false

  func finishIfDone() {
    if stopping && !waitingForAnswer && !exiting {
      exiting = true
      exit(0)
    }
  }

  func open() {
    generation += 1
    let mine = generation
    let next = makeRequest(SFSpeechAudioBufferRecognitionRequest(), terms: terms)
    next.shouldReportPartialResults = true
    request = next
    for buffer in pending { next.append(buffer) }
    pending.removeAll()
    pendingFrames = 0
    // The utterances of this request. After a pause of a couple of seconds
    // the on-device recognizer closes the utterance on its own — its last
    // partial carries the utterance's metadata — and then starts its
    // transcript over: the partials after that, and the request's own
    // final, carry only the words after the pause, and the words before it
    // are never delivered as a final (owner-hit: "it takes over the words
    // already there"). They are delivered here as a final of their own, at
    // the metadata when the recognizer gives it, else the moment the restart
    // shows; and what was settled this way is never delivered twice.
    var heard = ""     // the partial words not settled yet
    var settled = ""   // the recognizer's text already delivered, for the words that follow it
    let fresh = { (text: String) -> String in
      if settled.isEmpty || text == settled { return settled.isEmpty ? text : "" }
      return text.hasPrefix(settled) ? String(text.dropFirst(settled.count)).trimmingCharacters(in: .whitespaces) : text
    }
    let settle = { (words: String, why: String) in
      guard !words.isEmpty else { return }
      warn("utterance settled by the helper (\(why)): \(words.count) chars")
      emit(["kind": "final", "text": words])
      emit(["kind": "interim", "text": ""])
      heard = ""
    }
    _ = recognizer.recognitionTask(with: next) { result, error in
      state.async {
        if let result = result {
          let text = fresh(result.bestTranscription.formattedString)
          if result.isFinal {
            heard = ""
            if !text.isEmpty { emit(["kind": "final", "text": text]) }
            emit(["kind": "interim", "text": ""])
            if mine == generation {
              // The recognizer ended the segment on its own; a new one opens.
              request = nil
              waitingForAnswer = false
              if !stopping { open() }
            } else {
              waitingForAnswer = false
              if !stopping { open() }
            }
            finishIfDone()
          } else if mine == generation {
            if text.isEmpty {
              emit(["kind": "interim", "text": ""])
              return
            }
            var closed = false
            if #available(macOS 11.0, *) { closed = result.speechRecognitionMetadata != nil }
            if closed {
              settled = result.bestTranscription.formattedString
              settle(text, "the recognizer closed the utterance")
              return
            }
            if restarted(from: heard, to: text) {
              settled = ""
              settle(heard, "the recognizer restarted its transcript")
            }
            heard = text
            emit(["kind": "interim", "text": text])
          }
          return
        }
        if let error = error {
          let ns = error as NSError
          // Words heard before the request failed are words heard.
          if mine == generation { settle(heard, "the request ended with \(ns.domain) \(ns.code)") }
          // A request ended without words — cancelled, or nothing but silence —
          // is a segment closing, not a fault worth the room's attention.
          let quiet = (ns.domain == "kAFAssistantErrorDomain" && (ns.code == 216 || ns.code == 1110))
            || (ns.domain == "kLSRErrorDomain" && ns.code == 301)
          if !quiet { emit(["kind": "error", "message": "\(error.localizedDescription) [\(ns.domain) \(ns.code)]"]) }
          if mine == generation { request = nil }
          waitingForAnswer = false
          if !stopping { open() }
          finishIfDone()
        }
      }
    }
  }

  func commit(thenStop: Bool) {
    if thenStop { stopping = true }
    guard let current = request else {
      finishIfDone()
      return
    }
    waitingForAnswer = true
    current.endAudio()
    request = nil
    if thenStop {
      // The last final arrives a moment after the audio ends; wait for it, but not for ever.
      state.asyncAfter(deadline: .now() + 8) { if !exiting { exiting = true; exit(0) } }
    }
  }

  state.sync { open() }
  emit(["kind": "ready"])

  let reader = Thread {
    let input = FileHandle.standardInput
    while true {
      let header = input.readData(ofLength: 5)
      if header.count < 5 { state.async { commit(thenStop: true) }; break }
      let kind = header[0]
      let length = Int(header[1]) | Int(header[2]) << 8 | Int(header[3]) << 16 | Int(header[4]) << 24
      let payload = length > 0 ? input.readData(ofLength: length) : Data()
      if length > 0 && payload.count < length { state.async { commit(thenStop: true) }; break }
      switch kind {
      case 0:
        if let buffer = pcmBuffer(payload, format: format) {
          state.async {
            if let current = request {
              current.append(buffer)
            } else if !stopping && pendingFrames < AVAudioFrameCount(rate * 30) {
              pending.append(buffer)
              pendingFrames += buffer.frameLength
            }
          }
        }
      case 1:
        state.async { commit(thenStop: false) }
      case 2:
        state.async { commit(thenStop: true) }
      default:
        break
      }
    }
  }
  reader.start()
  RunLoop.main.run()

default:
  fail("unknown mode \(mode)")
}
