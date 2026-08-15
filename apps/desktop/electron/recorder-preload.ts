import { contextBridge, ipcRenderer } from "electron";

/**
 * The recorder page (D-123): a hidden, Novus-owned window whose only job is
 * to encode the preview's frames. The display-media handler installed by the
 * main process answers its `getDisplayMedia` with the preview view's own
 * contents — this page can name no source, pick no window, and reach no
 * pixels the main process did not hand it. Chunks stream to the main process,
 * which owns the file, the digest, the upload, and every decision.
 *
 * Start and stop arrive as `executeJavaScript` calls carrying a user gesture,
 * because Chromium requires transient activation for `getDisplayMedia`; the
 * results travel back over ipc. No microphone and no system audio:
 * `audio: false` is structural, not a default (D-123).
 */

let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;

function teardown(): void {
  recorder = null;
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
}

contextBridge.exposeInMainWorld("__novusRecorder", {
  start: async (frameRate: number): Promise<void> => {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: { frameRate: { ideal: frameRate, max: 30 } }
      });
      const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
        ? "video/webm;codecs=vp9"
        : "video/webm;codecs=vp8";
      recorder = new MediaRecorder(stream, { mimeType });
      recorder.ondataavailable = async (event) => {
        if (event.data.size === 0) return;
        const buffer = await event.data.arrayBuffer();
        ipcRenderer.send("record:chunk", buffer);
      };
      recorder.onstop = () => {
        ipcRenderer.send("record:ended");
        teardown();
      };
      recorder.onerror = () => {
        ipcRenderer.send("record:error", "The encoder reported an error.");
        teardown();
      };
      // The source vanishing — the preview view coming down mid-recording —
      // ends the track; the main process hears it and settles honestly.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => {
        ipcRenderer.send("record:source-ended");
        try {
          if (recorder?.state === "recording") recorder.stop();
        } catch {
          /* already stopping */
        }
      });
      recorder.start(1000);
      ipcRenderer.send("record:started", { mimeType });
    } catch (error) {
      ipcRenderer.send(
        "record:error",
        error instanceof Error ? `${error.name}: ${error.message}` : "Recording could not start."
      );
      teardown();
    }
  },
  stop: (): void => {
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
      else ipcRenderer.send("record:ended");
    } catch {
      ipcRenderer.send("record:error", "The encoder could not stop cleanly.");
      teardown();
    }
  }
});
