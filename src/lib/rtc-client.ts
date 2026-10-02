import { Room, RoomEvent, Track } from "livekit-client";

export type RtcConfiguration =
  | { provider: "demo"; message?: string }
  | { provider: "livekit"; url: string; token: string; roomName?: string };

export type RtcConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "permission-denied";

export type RtcMediaTile = {
  id: string;
  label: string;
  kind: "audio" | "video";
  local: boolean;
  attach: (element: HTMLMediaElement) => void;
  detach: (element: HTMLMediaElement) => void;
};

export type RtcCallbacks = {
  onState: (state: RtcConnectionState, message?: string) => void;
  onTracks: (tracks: RtcMediaTile[]) => void;
};

export interface RtcClient {
  connect: (devices?: { microphone: boolean; camera: boolean }) => Promise<void>;
  setMicrophone: (enabled: boolean) => Promise<void>;
  setCamera: (enabled: boolean) => Promise<void>;
  disconnect: () => Promise<void>;
}

export function mediaErrorMessage(error: unknown): string {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") {
    return "设备权限被拒绝。请在浏览器设置中允许摄像头或麦克风，然后重试；文字答疑仍可使用。";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "未找到所选摄像头或麦克风。请连接设备，或只测试可用的设备；文字答疑仍可使用。";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "设备无法打开，可能正被其他应用占用。请释放设备后重试；文字答疑仍可使用。";
  }
  return "音视频连接或设备访问失败，请检查网络和设备后重试；文字答疑仍可使用。";
}

function reportMediaError(callbacks: RtcCallbacks, error: unknown) {
  const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
  callbacks.onState(name === "NotAllowedError" || name === "PermissionDeniedError" ? "permission-denied" : "failed", mediaErrorMessage(error));
}

function ensureMediaDevices() {
  if (globalThis.isSecureContext === false || !globalThis.navigator?.mediaDevices?.getUserMedia) {
    throw new Error("当前浏览器不支持设备访问。请使用 HTTPS 或 localhost 上的现代浏览器；文字答疑仍可使用。");
  }
}

class DevicePreviewClient implements RtcClient {
  private streams: MediaStream[] = [];
  private generation = 0;

  constructor(private callbacks: RtcCallbacks) {}

  private publish() {
    const tiles: RtcMediaTile[] = this.streams.flatMap((stream) => stream.getTracks().map((track) => ({
      id: track.id,
      label: track.kind === "video" ? "自己的摄像头预览" : "自己的麦克风（不播放回声）",
      kind: track.kind as "audio" | "video",
      local: true,
      attach: (element: HTMLMediaElement) => {
        element.srcObject = new MediaStream([track]);
        element.muted = true;
      },
      detach: (element: HTMLMediaElement) => { element.srcObject = null; },
    })));
    this.callbacks.onTracks(tiles);
  }

  private async acquire(microphone: boolean, camera: boolean) {
    ensureMediaDevices();
    if (!microphone && !camera) return;
    const generation = this.generation;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: microphone, video: camera });
    // Permission prompts can resolve after the user ends or leaves the room.
    if (generation !== this.generation) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.streams.push(stream);
    this.publish();
  }

  async connect(devices = { microphone: true, camera: true }) {
    const generation = this.generation;
    this.callbacks.onState("connecting");
    try {
      await this.acquire(devices.microphone, devices.camera);
      if (generation === this.generation) this.callbacks.onState("connected");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("当前浏览器")) {
        this.callbacks.onState("failed", error.message);
      } else {
        reportMediaError(this.callbacks, error);
      }
      throw error;
    }
  }

  private async setDevice(kind: "audio" | "video", enabled: boolean) {
    const tracks = this.streams.flatMap((stream) => stream.getTracks()).filter((track) => track.kind === kind);
    if (enabled && tracks.length === 0) {
      try {
        await this.acquire(kind === "audio", kind === "video");
        this.callbacks.onState("connected");
      } catch (error) {
        reportMediaError(this.callbacks, error);
        throw error;
      }
    } else if (!enabled) {
      tracks.forEach((track) => {
        track.stop();
        this.streams.forEach((stream) => stream.removeTrack(track));
      });
      this.publish();
    }
  }

  setMicrophone(enabled: boolean) { return this.setDevice("audio", enabled); }
  setCamera(enabled: boolean) { return this.setDevice("video", enabled); }

  async disconnect() {
    this.generation += 1;
    this.streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
    this.streams = [];
    this.callbacks.onTracks([]);
    this.callbacks.onState("idle");
  }
}

class LiveKitRtcClient implements RtcClient {
  private room = new Room({ adaptiveStream: true, dynacast: true });
  private tiles = new Map<string, RtcMediaTile>();
  private stopped = false;

  constructor(private configuration: Extract<RtcConfiguration, { provider: "livekit" }>, private callbacks: RtcCallbacks) {
    const addTrack = (track: Track, identity: string, local: boolean) => {
      if (this.stopped || (track.kind !== Track.Kind.Video && track.kind !== Track.Kind.Audio)) return;
      const id = `${identity}:${track.kind}`;
      this.tiles.set(id, {
        id,
        label: local ? "自己" : "对方",
        kind: track.kind as "audio" | "video",
        local,
        attach: (element) => { track.attach(element); element.muted = local; },
        detach: (element) => { track.detach(element); },
      });
      this.callbacks.onTracks([...this.tiles.values()]);
    };
    const removeTrack = (identity: string, kind: string) => {
      this.tiles.delete(`${identity}:${kind}`);
      this.callbacks.onTracks([...this.tiles.values()]);
    };
    this.room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => addTrack(track, participant.identity, false));
    this.room.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => removeTrack(participant.identity, track.kind));
    this.room.on(RoomEvent.LocalTrackPublished, (publication, participant) => {
      if (publication.track) addTrack(publication.track, participant.identity, true);
    });
    this.room.on(RoomEvent.LocalTrackUnpublished, (publication, participant) => removeTrack(participant.identity, publication.kind));
    this.room.on(RoomEvent.Reconnecting, () => { if (!this.stopped) this.callbacks.onState("reconnecting", "连接中断，正在重新连接；文字答疑仍可使用。"); });
    this.room.on(RoomEvent.Reconnected, () => { if (!this.stopped) this.callbacks.onState("connected"); });
    this.room.on(RoomEvent.Disconnected, () => {
      this.tiles.clear();
      this.callbacks.onTracks([]);
      if (!this.stopped) this.callbacks.onState("failed", "音视频连接已断开，可重新接入；文字答疑仍可使用。");
    });
    this.room.on(RoomEvent.MediaDevicesError, (error) => { if (!this.stopped) reportMediaError(this.callbacks, error); });
  }

  async connect(devices = { microphone: true, camera: true }) {
    this.callbacks.onState("connecting");
    try {
      await this.room.connect(this.configuration.url, this.configuration.token);
      if (this.stopped) { await this.room.disconnect(true); return; }
      if (devices.microphone || devices.camera) ensureMediaDevices();
      await this.room.localParticipant.setMicrophoneEnabled(devices.microphone);
      if (this.stopped) { await this.disconnect(); return; }
      await this.room.localParticipant.setCameraEnabled(devices.camera);
      if (this.stopped) { await this.disconnect(); return; }
      this.callbacks.onState("connected");
    } catch (error) {
      if (!this.stopped) reportMediaError(this.callbacks, error);
      throw error;
    }
  }

  async setMicrophone(enabled: boolean) {
    if (this.stopped) return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(enabled);
      if (this.stopped) await this.disconnect();
    }
    catch (error) { reportMediaError(this.callbacks, error); throw error; }
  }

  async setCamera(enabled: boolean) {
    if (this.stopped) return;
    try {
      await this.room.localParticipant.setCameraEnabled(enabled);
      if (this.stopped) await this.disconnect();
    }
    catch (error) { reportMediaError(this.callbacks, error); throw error; }
  }

  async disconnect() {
    this.stopped = true;
    this.room.localParticipant.trackPublications.forEach((publication) => publication.track?.stop());
    await this.room.disconnect(true);
    this.tiles.clear();
    this.callbacks.onTracks([]);
    this.callbacks.onState("idle");
  }
}

export function createRtcClient(configuration: RtcConfiguration, callbacks: RtcCallbacks): RtcClient {
  if (configuration.provider === "demo") return new DevicePreviewClient(callbacks);
  if (!configuration.url || !configuration.token) throw new Error("音视频配置不完整，暂时无法接入。文字答疑仍可使用。");
  return new LiveKitRtcClient(configuration, callbacks);
}
