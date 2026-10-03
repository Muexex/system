"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";
import { createRtcClient, type RtcClient, type RtcConfiguration, type RtcConnectionState, type RtcMediaTile } from "@/lib/rtc-client";

function MediaTile({ tile }: { tile: RtcMediaTile }) {
  const element = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
  useEffect(() => {
    const media = element.current;
    if (!media) return;
    tile.attach(media);
    void media.play().catch(() => { /* Browsers may require another user gesture to play remote audio. */ });
    return () => tile.detach(media);
  }, [tile]);
  if (tile.kind === "audio") return <audio ref={(node) => { element.current = node; }} autoPlay controls={!tile.local} muted={tile.local} aria-label={tile.label} style={{ maxWidth: "100%" }} />;
  return <figure className="rtc-tile" style={{ margin: 0, minWidth: 0 }}>
    <video ref={(node) => { element.current = node; }} autoPlay playsInline muted={tile.local} style={{ width: "100%", minHeight: 120, maxHeight: 240, borderRadius: 12, background: "#182820", objectFit: "cover" }} />
    <figcaption className="muted" style={{ fontSize: 12, marginTop: 4 }}>{tile.label}</figcaption>
  </figure>;
}

export function RtcPanel({ sessionId, ended }: { sessionId: string; ended: boolean }) {
  const [provider, setProvider] = useState<"demo" | "livekit" | null>(null);
  const [state, setState] = useState<RtcConnectionState>("idle");
  const [message, setMessage] = useState("");
  const [tracks, setTracks] = useState<RtcMediaTile[]>([]);
  const [microphone, setMicrophone] = useState(false);
  const [camera, setCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const client = useRef<RtcClient | null>(null);
  const generation = useRef(0);
  const active = useRef(!ended);

  useEffect(() => {
    active.current = !ended;
    if (ended) {
      generation.current += 1;
      const oldClient = client.current;
      client.current = null;
      void oldClient?.disconnect();
      setMicrophone(false);
      setCamera(false);
      setTracks([]);
      setBusy(false);
    }
    return () => {
      active.current = false;
      generation.current += 1;
      const oldClient = client.current;
      client.current = null;
      void oldClient?.disconnect();
    };
  }, [sessionId, ended]);

  async function connect(devices = { microphone: true, camera: true }) {
    if (busy || ended) return;
    setBusy(true);
    setMessage("");
    setState("connecting");
    const attempt = ++generation.current;
    let adapterStarted = false;
    let safeErrorMessage = "音视频暂时不可用，请检查网络后重试；文字答疑仍可使用。";
    try {
      const oldClient = client.current;
      client.current = null;
      await oldClient?.disconnect();
      let result: RtcConfiguration;
      try { result = await api<RtcConfiguration>(`/sessions/${encodeURIComponent(sessionId)}/rtc`); }
      catch (error) {
        if (error instanceof Error) safeErrorMessage = error.message;
        throw error;
      }
      if (!active.current || attempt !== generation.current) return;
      setProvider(result.provider);
      if (result.provider === "demo" && result.message) setMessage(result.message);
      const nextClient = createRtcClient(result, {
        onState: (nextState, error) => {
          if (!active.current || attempt !== generation.current) return;
          setState(nextState);
          if (error) setMessage(error);
        },
        onTracks: (nextTracks) => {
          if (!active.current || attempt !== generation.current) return;
          setTracks(nextTracks);
          setMicrophone(nextTracks.some((track) => track.local && track.kind === "audio"));
          setCamera(nextTracks.some((track) => track.local && track.kind === "video"));
        },
      });
      client.current = nextClient;
      adapterStarted = true;
      await nextClient.connect(devices);
      if (!active.current || attempt !== generation.current) { await nextClient.disconnect(); return; }
      setMicrophone(devices.microphone);
      setCamera(devices.camera);
    } catch {
      if (!active.current || attempt !== generation.current) return;
      // Adapter callbacks preserve the more specific permission-denied state.
      setState((current) => current === "permission-denied" ? current : "failed");
      if (!adapterStarted) setMessage(safeErrorMessage);
    } finally {
      if (attempt === generation.current) setBusy(false);
    }
  }

  async function toggle(kind: "microphone" | "camera") {
    if (busy || ended) return;
    const enabled = kind === "microphone" ? microphone : camera;
    if (!client.current || state === "failed" || state === "permission-denied") {
      await connect({ microphone: kind === "microphone", camera: kind === "camera" });
      return;
    }
    const attempt = generation.current;
    setBusy(true);
    try {
      if (kind === "microphone") {
        await client.current.setMicrophone(!enabled);
        if (!active.current || attempt !== generation.current) return;
        setMicrophone(!enabled);
      } else {
        await client.current.setCamera(!enabled);
        if (!active.current || attempt !== generation.current) return;
        setCamera(!enabled);
      }
      setMessage("");
    } catch { /* The adapter supplies a safe, specific device error. */ }
    finally { if (attempt === generation.current) setBusy(false); }
  }

  async function disconnect() {
    generation.current += 1;
    const oldClient = client.current;
    client.current = null;
    await oldClient?.disconnect();
    setTracks([]);
    setMicrophone(false);
    setCamera(false);
    setState("idle");
    setMessage("");
    setBusy(false);
  }

  const connectionLabel = ended ? "答疑已结束，设备已关闭" : {
    idle: "尚未开启", connecting: "连接中…", connected: provider === "demo" ? "设备预览已开启" : "已连接音视频房间",
    reconnecting: "重新连接中…", failed: "接入失败，可重试", "permission-denied": "设备权限被拒绝",
  }[state];
  const videos = tracks.filter((track) => track.kind === "video");

  return <section className="rtc-panel" aria-label="音视频与设备预览" style={{ border: "1px solid var(--border, #dde5df)", borderRadius: 16, padding: 16, background: "var(--surface, #fff)" }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <strong>音视频</strong><span className="muted" aria-live="polite" style={{ fontSize: 12 }}>{connectionLabel}</span>
    </div>
    <p className="muted" style={{ fontSize: 13, lineHeight: 1.7, margin: "8px 0 12px" }}>
      {provider === "livekit" ? "点击接入后才能使用真人音视频。双方都需主动接入。" : "设备预览模式，尚未接入双人音视频。"}
      {provider !== "livekit" && "预览仅在自己的设备上显示，文字答疑正常可用。"}
    </p>
    {message && <p role="alert" style={{ fontSize: 13, lineHeight: 1.6, color: "#a0462a" }}>{message}</p>}
    <div className="rtc-grid" style={{ display: "grid", gridTemplateColumns: videos.length > 1 ? "repeat(2, minmax(0, 1fr))" : "1fr", gap: 10 }}>
      {tracks.map((track) => <MediaTile key={track.id} tile={track} />)}
      {videos.length === 0 && <div className="muted" style={{ padding: "26px 12px", textAlign: "center", background: "#f1f5f2", borderRadius: 12, fontSize: 13 }}>{ended ? "音视频设备已关闭" : "摄像头尚未开启"}</div>}
    </div>
    {provider === "livekit" && state === "connected" && !tracks.some((track) => !track.local) && <p className="muted" style={{ fontSize: 12 }}>等待对方主动接入音视频。</p>}
    <div className="rtc-toolbar" style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
      {(state === "idle" || state === "failed" || state === "permission-denied") && <button type="button" disabled={ended || busy} onClick={() => void connect()}>{busy ? "连接中…" : "开启音视频 / 设备预览"}</button>}
      <button type="button" disabled={ended || busy} aria-pressed={microphone} onClick={() => void toggle("microphone")}>{microphone ? "关闭麦克风" : "开启麦克风"}</button>
      <button type="button" disabled={ended || busy} aria-pressed={camera} onClick={() => void toggle("camera")}>{camera ? "关闭摄像头" : "开启摄像头"}</button>
      {client.current && <button type="button" disabled={ended || busy} onClick={() => void disconnect()}>退出音视频</button>}
    </div>
    <p className="muted" style={{ fontSize: 12, margin: "10px 0 0" }}>不默认录音录像。关闭设备或退出音视频不会结束文字答疑。</p>
  </section>;
}
