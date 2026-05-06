import { useEffect, useRef, useState } from "react";
import { PcmPlayer, startMicCapture, type MicCapture } from "../lib/audio";

interface Props {
  projectId: string | null;
  onSystemMessage: (text: string) => void;
  onPromptAgent: (text: string) => void;
  onFileChanged: (relPath: string) => void;
  onVoiceTaskStart: (instruction: string) => void;
  onVoiceTaskEnd: () => void;
  onDesignerMessage: (msg: any) => void;
}

const VISION_INTERVAL_MS = 8000; // throttle live-vision calls

type CamFacing = "user" | "environment";
type CamSource = "off" | "camera" | "screen";

export function MediaPanel({
  projectId,
  onSystemMessage,
  onPromptAgent,
  onFileChanged,
  onVoiceTaskStart,
  onVoiceTaskEnd,
  onDesignerMessage,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const visionTimer = useRef<number | null>(null);
  const visionInFlight = useRef(false);

  const [camSource, setCamSource] = useState<CamSource>("off");
  const [camFacing, setCamFacing] = useState<CamFacing>("user");
  const [camError, setCamError] = useState<string | null>(null);
  const [busySnap, setBusySnap] = useState(false);

  // Voice
  const wsRef = useRef<WebSocket | null>(null);
  const micRef = useRef<MicCapture | null>(null);
  const playerRef = useRef<PcmPlayer | null>(null);
  const [voiceMode, setVoiceMode] = useState<"off" | "connecting" | "live" | "error">("off");
  const [voiceErr, setVoiceErr] = useState("");
  const [speakerOn, setSpeakerOn] = useState(true);

  useEffect(() => {
    return () => {
      stopCam();
      stopVoice();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- camera / screen ----------
  async function startCamera() {
    if (!projectId) return;
    setCamError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: camFacing },
        audio: false,
      });
      attachStream(stream);
      setCamSource("camera");
    } catch (err: any) {
      setCamError(err?.message ?? "camera error");
    }
  }

  async function startScreen() {
    if (!projectId) return;
    setCamError(null);
    try {
      const stream = await (navigator.mediaDevices as any).getDisplayMedia({
        video: { width: 1280, height: 720 },
        audio: false,
      });
      stream.getVideoTracks()[0].onended = () => stopCam();
      attachStream(stream);
      setCamSource("screen");
    } catch (err: any) {
      setCamError(err?.message ?? "screen share cancelled");
    }
  }

  function attachStream(stream: MediaStream) {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = stream;
    const v = videoRef.current;
    if (v) {
      v.srcObject = stream;
      v.play().catch(() => {});
    }
    if (visionTimer.current) window.clearInterval(visionTimer.current);
    visionTimer.current = window.setInterval(visionTick, VISION_INTERVAL_MS);
    // first read after 1.5s once camera warms up
    window.setTimeout(visionTick, 1500);
  }

  function stopCam() {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (visionTimer.current) {
      window.clearInterval(visionTimer.current);
      visionTimer.current = null;
    }
    setCamSource("off");
  }

  async function flipCam() {
    if (camSource !== "camera") return;
    const next: CamFacing = camFacing === "user" ? "environment" : "user";
    setCamFacing(next);
    stopCam();
    // reuse next facing
    setTimeout(() => {
      void (async () => {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 1280, height: 720, facingMode: next },
            audio: false,
          });
          attachStream(stream);
          setCamSource("camera");
        } catch (err: any) {
          setCamError(err?.message ?? "camera error");
        }
      })();
    }, 100);
  }

  async function visionTick() {
    if (visionInFlight.current) return;
    if (!streamRef.current) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || !v.videoWidth) return;
    visionInFlight.current = true;
    try {
      c.width = 640;
      c.height = (640 * v.videoHeight) / v.videoWidth;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const blob: Blob | null = await new Promise((r) => c.toBlob((b) => r(b), "image/jpeg", 0.7));
      if (!blob) return;
      const b64 = await blobToBase64(blob);
      const res = await fetch("/api/vision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          imageBase64: b64,
          mediaType: "image/jpeg",
          prompt:
            "Describe what you see in 1-2 short sentences as design context — mood + 1 distinctive visual element. Skip preamble.",
        }),
      }).then((r) => r.json());
      if (res?.description) onSystemMessage(`👁️ ${res.description}`);
    } catch {
      // swallow ambient errors
    } finally {
      visionInFlight.current = false;
    }
  }

  async function snapToAssets() {
    if (!projectId) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || !v.videoWidth) {
      onSystemMessage("snap: turn on camera or screen first");
      return;
    }
    setBusySnap(true);
    try {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const blob: Blob | null = await new Promise((r) => c.toBlob((b) => r(b), "image/jpeg", 0.92));
      if (!blob) return;

      const fd = new FormData();
      fd.append("file", blob, "snap.jpg");
      const up = await fetch(`/api/projects/${projectId}/upload`, { method: "POST", body: fd }).then((r) => r.json());

      const b64 = await blobToBase64(blob);
      let visionDesc = "";
      try {
        const v2 = await fetch("/api/vision", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ imageBase64: b64, mediaType: "image/jpeg" }),
        }).then((r) => r.json());
        visionDesc = v2.description ?? "";
      } catch {}

      onSystemMessage(`📷 saved ${up.path} (${up.bytes} bytes)` + (visionDesc ? `\n\n${visionDesc}` : ""));
      onPromptAgent(
        `I just uploaded a reference photo at \`${up.path}\`. ${visionDesc ? `Vision read:\n\n${visionDesc}\n\n` : ""}Use this image in the page (hero, mood, palette). Update site/index.html and site/styles.css accordingly.`,
      );
    } finally {
      setBusySnap(false);
    }
  }

  // ---------- voice ----------
  async function startVoice() {
    if (!projectId) return;
    setVoiceMode("connecting");
    setVoiceErr("");

    const player = new PcmPlayer();
    playerRef.current = player;
    // Resume the AudioContext within the click gesture so playback works
    // (browsers suspend AudioContexts created without a user gesture).
    await player.resume();
    player.setMuted(!speakerOn);

    const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/voice/${projectId}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = async () => {
      try {
        const mic = await startMicCapture((b64) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
          }
        });
        micRef.current = mic;
        setVoiceMode("live");
        onSystemMessage("🎙️ voice live");
      } catch (err: any) {
        setVoiceErr(err?.message ?? String(err));
        setVoiceMode("error");
      }
    };

    ws.onmessage = (e) => {
      let evt: any;
      try {
        evt = JSON.parse(e.data);
      } catch {
        return;
      }
      handleVoiceEvent(evt);
    };
    ws.onclose = () => stopVoice();
    ws.onerror = () => {
      setVoiceErr("voice WS error");
      setVoiceMode("error");
    };
  }

  function handleVoiceEvent(evt: any) {
    if (evt.type === "response.audio.delta" && evt.delta) {
      playerRef.current?.push(evt.delta);
      return;
    }
    if (evt.type === "session.created" || evt.type === "session.updated") {
      onSystemMessage(`🎙️ ${evt.type}`);
      return;
    }
    if (evt.type === "response.done" && evt.response?.status_details?.error) {
      onSystemMessage(`🎙️ realtime error: ${JSON.stringify(evt.response.status_details.error)}`);
      return;
    }
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      if (evt.transcript) onSystemMessage(`🎙️ "${evt.transcript.trim()}"`);
      return;
    }
    if (evt.type === "designer_start") {
      onVoiceTaskStart(evt.instruction);
      return;
    }
    if (evt.type === "designer_end") {
      onVoiceTaskEnd();
      return;
    }
    if (evt.type === "designer_msg" && evt.msg) {
      onDesignerMessage(evt.msg);
      return;
    }
    if (evt.type === "file_changed") {
      onFileChanged(evt.path);
      return;
    }
    if (evt.type === "error") {
      const msg = evt.error?.message ?? evt.message ?? "voice error";
      const code = evt.error?.code ? ` [${evt.error.code}]` : "";
      onSystemMessage(`🎙️ ${msg}${code}`);
      setVoiceErr(msg);
      setVoiceMode("error");
      stopVoice();
      return;
    }
    if (evt.type === "voice_closed") {
      stopVoice();
      return;
    }
  }

  function stopVoice() {
    micRef.current?.stop();
    micRef.current = null;
    playerRef.current?.close();
    playerRef.current = null;
    wsRef.current?.close();
    wsRef.current = null;
    setVoiceMode("off");
  }

  const camOn = camSource !== "off";

  return (
    <div className="media-panel">
      <div className={`cam-stage ${camOn ? "on" : "off"}`}>
        {!camOn ? <div className="cam-placeholder">Camera off</div> : null}
        <video ref={videoRef} autoPlay playsInline muted style={{ display: camOn ? "block" : "none" }} />
        <canvas ref={canvasRef} style={{ display: "none" }} />
        {camOn ? (
          <>
            <span className={`cam-tag`}>{camSource === "screen" ? "screen" : `camera · ${camFacing}`}</span>
            <button
              className="cam-snap"
              onClick={snapToAssets}
              disabled={busySnap}
              title="snap a reference photo into the project's assets"
            >
              {busySnap ? "saving…" : "snap →"}
            </button>
          </>
        ) : null}
      </div>

      <div className="media-controls">
        <button
          className={`ctrl ${camSource === "camera" ? "active" : ""}`}
          disabled={!projectId}
          onClick={camSource === "camera" ? stopCam : startCamera}
        >
          {camSource === "camera" ? "■ camera" : "🎥 camera"}
        </button>
        <button
          className="ctrl ctrl-icon"
          disabled={camSource !== "camera"}
          onClick={flipCam}
          title="flip front/back"
        >
          ⇋
        </button>
        <button
          className={`ctrl ${camSource === "screen" ? "active" : ""}`}
          disabled={!projectId}
          onClick={camSource === "screen" ? stopCam : startScreen}
        >
          {camSource === "screen" ? "■ screen" : "🖥️ screen"}
        </button>
        <button
          className={`ctrl ${voiceMode === "live" ? "active" : ""}`}
          disabled={!projectId || voiceMode === "connecting"}
          onClick={voiceMode === "live" ? stopVoice : startVoice}
          title={voiceErr || ""}
        >
          {voiceMode === "live" ? "■ mic" : voiceMode === "connecting" ? "…" : "🎙️ mic"}
        </button>
        <button
          className={`ctrl ${speakerOn ? "active" : ""}`}
          onClick={() => {
            const next = !speakerOn;
            setSpeakerOn(next);
            playerRef.current?.setMuted(!next);
          }}
          title="speaker (voice replies)"
        >
          {speakerOn ? "🔊" : "🔇"}
        </button>
      </div>

      {camError ? <div className="media-err">{camError}</div> : null}
    </div>
  );
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = r.result as string;
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}
