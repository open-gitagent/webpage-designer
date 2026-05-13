import { useEffect, useRef, useState } from "react";
import {
  Camera as CameraIcon,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  RefreshCw,
  Square,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { PcmPlayer, startMicCapture, type MicCapture } from "../lib/audio";
import { CaptureFx } from "./CaptureFx";

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
  const [captureFxKey, setCaptureFxKey] = useState(0);
  const flashCapture = () => setCaptureFxKey((n) => n + 1);

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
      fullStopVoice();
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

  async function snapToAssets(withCutout = false) {
    if (!projectId) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c || !v.videoWidth) {
      onSystemMessage("snap: turn on camera or screen first");
      return;
    }
    setBusySnap(true);
    flashCapture();
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

      let cutoutPath: string | null = null;
      let studioPath: string | null = null;
      let cutoutErr = "";
      let studioErr = "";
      if (withCutout) {
        onSystemMessage(`✨ studio-izing the snap…`);
        const baseName = (up.path as string).replace(/^assets\//, "").replace(/\.[a-z]+$/i, "");
        // Step 1 — studio-ize the raw frame (clean lighting + neutral backdrop).
        try {
          const s = await fetch(`/api/projects/${projectId}/studio`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: up.path, output_filename: `${baseName}-studio.jpg` }),
          }).then((r) => r.json());
          if (s?.rel) studioPath = s.rel;
          else studioErr = s?.error ?? "studio-ize failed";
        } catch (err: any) {
          studioErr = err?.message ?? "studio-ize failed";
        }

        // Step 2 — rembg the studio version (or raw fallback) so the cutout
        // carries studio lighting rather than phone-cam noise.
        const cutoutSource = studioPath ?? up.path;
        const cutoutName = studioPath ? `${baseName}-studio-cutout.png` : `${baseName}-cutout.png`;
        onSystemMessage(`✂️ removing background from ${studioPath ? "studio" : "raw"} version…`);
        try {
          const cut = await fetch(`/api/projects/${projectId}/cutout`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: cutoutSource, output_filename: cutoutName }),
          }).then((r) => r.json());
          if (cut?.rel) cutoutPath = cut.rel;
          else cutoutErr = cut?.error ?? "rembg failed";
        } catch (err: any) {
          cutoutErr = err?.message ?? "rembg failed";
        }
      }

      const summaryLines = [
        `📷 saved ${up.path} (${up.bytes} bytes)`,
        studioPath ? `✨ studio: ${studioPath}` : studioErr ? `✨ studio failed: ${studioErr}` : "",
        cutoutPath ? `✂️ cutout: ${cutoutPath}` : cutoutErr ? `✂️ cutout failed: ${cutoutErr}` : "",
        visionDesc ? `\n${visionDesc}` : "",
      ].filter(Boolean);
      onSystemMessage(summaryLines.join("\n"));

      const variantLine = [
        `\`${up.path}\` (raw original — atmosphere/reference only)`,
        studioPath ? `\`${studioPath}\` (studio-grade full shot — for full-bleed feature sections)` : "",
        cutoutPath
          ? `\`${cutoutPath}\` (studio-lit transparent cutout — **default hero**, layer over color block or photograph)`
          : "",
      ]
        .filter(Boolean)
        .join("\n- ");

      const promptParts = [
        `I just captured an image and ran it through the pipeline. Variants in site/assets/ (in pipeline order):\n- ${variantLine}`,
        visionDesc ? `Vision read:\n\n${visionDesc}` : "",
        cutoutPath
          ? `Default to the **cutout** for the hero — it has studio-grade lighting baked in. Use the studio version for a full-bleed feature section. Use the raw only for mood/atmosphere with heavy treatment. Update site/index.html and site/styles.css accordingly.`
          : studioPath
            ? `Studio-ize succeeded but cutout failed — use the studio version for the hero, treated as a full-bleed image with type overlaid.`
            : `Use this image prominently — hero placement, mood, or palette anchor.`,
      ].filter(Boolean);
      onPromptAgent(promptParts.join("\n\n"));
    } finally {
      setBusySnap(false);
    }
  }

  async function snapForVoice(requestId: string, filenameHint: string, _reason: string) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const v = videoRef.current;
    const c = canvasRef.current;
    if (!projectId || !v || !c || !v.videoWidth || !streamRef.current) {
      ws.send(JSON.stringify({ type: "frame_captured", request_id: requestId, error: "no camera active" }));
      return;
    }
    flashCapture();
    try {
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
      const blob: Blob | null = await new Promise((r) => c.toBlob((b) => r(b), "image/jpeg", 0.92));
      if (!blob) {
        ws.send(JSON.stringify({ type: "frame_captured", request_id: requestId, error: "could not encode frame" }));
        return;
      }
      const safeHint = filenameHint.replace(/[^a-z0-9-]+/gi, "-").slice(0, 40) || "snap";
      const fd = new FormData();
      fd.append("file", blob, `${safeHint}-${Date.now()}.jpg`);
      const up = await fetch(`/api/projects/${projectId}/upload`, { method: "POST", body: fd }).then((r) => r.json());
      if (!up?.path) {
        ws.send(JSON.stringify({ type: "frame_captured", request_id: requestId, error: "upload failed" }));
        return;
      }
      ws.send(JSON.stringify({ type: "frame_captured", request_id: requestId, path: up.path, bytes: up.bytes }));
    } catch (err: any) {
      ws.send(JSON.stringify({ type: "frame_captured", request_id: requestId, error: err?.message ?? "snap error" }));
    }
  }

  // ---------- voice ----------
  async function startVoice() {
    if (!projectId) return;
    setVoiceMode("connecting");
    setVoiceErr("");

    // If a WS is still alive from a soft-stopped session (mic-off mid-build),
    // reuse it: just restart the mic capture instead of opening a duplicate.
    const existingWs = wsRef.current;
    if (existingWs && existingWs.readyState === WebSocket.OPEN) {
      try {
        const mic = await startMicCapture((b64) => {
          if (existingWs.readyState === WebSocket.OPEN) {
            existingWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }));
          }
        });
        micRef.current = mic;
        playerRef.current?.setMuted(!speakerOn);
        await playerRef.current?.resume();
        setVoiceMode("live");
        onSystemMessage("🎙️ voice resumed");
      } catch (err: any) {
        setVoiceErr(err?.message ?? String(err));
        setVoiceMode("error");
      }
      return;
    }

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
    ws.onclose = () => fullStopVoice();
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
    if (evt.type === "designer_queued") {
      onSystemMessage(`⏳ queued behind the current task: ${evt.instruction}`);
      return;
    }
    if (evt.type === "system_note") {
      onSystemMessage(evt.note ?? "");
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
    if (evt.type === "request_frame") {
      void snapForVoice(evt.request_id, evt.filename_hint, evt.reason);
      return;
    }
    if (evt.type === "voice_capture_start") {
      onSystemMessage(`📷 capturing ${evt.filename_hint}${evt.remove_background ? " (cutout)" : ""}: ${evt.reason ?? ""}`);
      return;
    }
    if (evt.type === "voice_capture_end") {
      if (evt.error) onSystemMessage(`📷 capture failed: ${evt.error}`);
      else if (evt.path) onSystemMessage(`📷 saved ${evt.path}`);
      return;
    }
    if (evt.type === "voice_look_start") {
      onSystemMessage(`👁️ glancing: ${evt.reason ?? ""}`);
      return;
    }
    if (evt.type === "voice_look_end") {
      if (evt.error) onSystemMessage(`👁️ glance failed: ${evt.error}`);
      else if (evt.description) onSystemMessage(`👁️ ${evt.description}`);
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
      fullStopVoice();
      return;
    }
    if (evt.type === "voice_closed") {
      fullStopVoice();
      return;
    }
  }

  /**
   * Soft mic-off — stops the mic capture but keeps the voice WS alive so
   * in-flight designer events (file_changed, designer_msg, designer_end)
   * keep flowing and the iframe keeps updating while the agent finishes.
   * Used by the mic button click. Full tear-down is reserved for socket
   * close/error and component unmount.
   */
  function stopVoice() {
    micRef.current?.stop();
    micRef.current = null;
    setVoiceMode("off");
    // playerRef + wsRef stay alive — design agent finishes flowing events
    // and the iframe keeps redrawing.
  }

  /** Hard tear-down of the entire voice session — mic, player, WS. */
  function fullStopVoice() {
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
        <CaptureFx fireKey={captureFxKey} />
        {camOn ? (
          <>
            <span className={`cam-tag`}>{camSource === "screen" ? "screen" : `camera · ${camFacing}`}</span>
            <div className="cam-actions">
              <button
                className="cam-snap cam-snap-cutout"
                onClick={() => snapToAssets(true)}
                disabled={busySnap}
                title="snap → background removed → save raw + cutout"
              >
                <CameraIcon size={13} strokeWidth={1.75} />
                {busySnap ? "saving…" : "snap"}
              </button>
              <button
                className="cam-snap cam-snap-raw"
                onClick={() => snapToAssets(false)}
                disabled={busySnap}
                title="snap raw (no background removal) — for mood / atmosphere photos"
              >
                raw
              </button>
            </div>
          </>
        ) : null}
      </div>

      <div className="media-controls">
        <button
          className={`ctrl ${camSource === "camera" ? "active" : ""}`}
          disabled={!projectId}
          onClick={camSource === "camera" ? stopCam : startCamera}
        >
          {camSource === "camera" ? <VideoOff size={14} strokeWidth={1.75} /> : <Video size={14} strokeWidth={1.75} />}
          camera
        </button>
        <button
          className="ctrl ctrl-icon"
          disabled={camSource !== "camera"}
          onClick={flipCam}
          title="flip front/back"
        >
          <RefreshCw size={14} strokeWidth={1.75} />
        </button>
        <button
          className={`ctrl ${camSource === "screen" ? "active" : ""}`}
          disabled={!projectId}
          onClick={camSource === "screen" ? stopCam : startScreen}
        >
          {camSource === "screen" ? <MonitorOff size={14} strokeWidth={1.75} /> : <Monitor size={14} strokeWidth={1.75} />}
          screen
        </button>
        <button
          className={`ctrl ${voiceMode === "live" ? "active" : ""}`}
          disabled={!projectId || voiceMode === "connecting"}
          onClick={voiceMode === "live" ? stopVoice : startVoice}
          title={voiceErr || ""}
        >
          {voiceMode === "connecting" ? (
            <Loader2 size={14} strokeWidth={1.75} className="ctrl-spin" />
          ) : voiceMode === "live" ? (
            <Square size={14} strokeWidth={1.75} fill="currentColor" />
          ) : (
            <Mic size={14} strokeWidth={1.75} />
          )}
          mic
        </button>
        <button
          className={`ctrl ctrl-icon ${speakerOn ? "active" : ""}`}
          onClick={() => {
            const next = !speakerOn;
            setSpeakerOn(next);
            playerRef.current?.setMuted(!next);
            // Tell OpenAI Realtime to stop synthesizing audio while muted (saves
            // tokens and keeps things responsive). The model keeps listening,
            // thinking, and calling functions — only audio out is suppressed.
            // Conversation context is preserved server-side, so unmuting picks
            // up from the model's current state without losing anything.
            const ws = wsRef.current;
            if (ws?.readyState === WebSocket.OPEN && voiceMode === "live") {
              ws.send(
                JSON.stringify({
                  type: "session.update",
                  session: { modalities: next ? ["audio", "text"] : ["text"] },
                }),
              );
              onSystemMessage(next ? "🔊 unmuted — model will speak again" : "🔇 muted — model keeps listening, no audio out");
            }
          }}
          title={speakerOn ? "speaker on (model speaks)" : "speaker muted (model thinks silently)"}
        >
          {speakerOn ? <Volume2 size={14} strokeWidth={1.75} /> : <VolumeX size={14} strokeWidth={1.75} />}
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
