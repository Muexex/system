import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const livekit = vi.hoisted(() => ({
  room: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn(),
    localParticipant: {
      setMicrophoneEnabled: vi.fn(),
      setCameraEnabled: vi.fn(),
      trackPublications: new Map<string, { track?: { stop: () => void } }>(),
    },
  },
}));

vi.mock("livekit-client", () => ({
  Room: vi.fn(function () { return livekit.room; }),
  RoomEvent: {
    TrackSubscribed: "trackSubscribed", TrackUnsubscribed: "trackUnsubscribed",
    LocalTrackPublished: "localTrackPublished", LocalTrackUnpublished: "localTrackUnpublished",
    Reconnecting: "reconnecting", Reconnected: "reconnected", Disconnected: "disconnected", MediaDevicesError: "mediaDevicesError",
  },
  Track: { Kind: { Audio: "audio", Video: "video" } },
}));

import { createRtcClient, mediaErrorMessage } from "../src/lib/rtc-client";

class FakeTrack {
  id: string;
  stop = vi.fn();
  constructor(public kind: "audio" | "video") { this.id = kind; }
}

class FakeStream {
  constructor(private tracks: FakeTrack[]) {}
  getTracks() { return [...this.tracks]; }
  removeTrack(track: FakeTrack) { this.tracks = this.tracks.filter((item) => item !== track); }
}

function callbacks() { return { onState: vi.fn(), onTracks: vi.fn() }; }

describe("RTC client adapter (mock SDK, no real call)", () => {
  const getUserMedia = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    livekit.room.localParticipant.trackPublications.clear();
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("does not request devices on creation and stops only the requested preview tracks", async () => {
    const audio = new FakeTrack("audio");
    const video = new FakeTrack("video");
    getUserMedia.mockResolvedValue(new FakeStream([audio, video]));
    const events = callbacks();
    const client = createRtcClient({ provider: "demo" }, events);
    expect(getUserMedia).not.toHaveBeenCalled();
    await client.connect();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(events.onTracks.mock.lastCall?.[0]).toHaveLength(2);
    await client.setCamera(false);
    expect(video.stop).toHaveBeenCalledTimes(1);
    expect(audio.stop).not.toHaveBeenCalled();
    await client.disconnect();
    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(events.onTracks).toHaveBeenLastCalledWith([]);
    expect(events.onState).toHaveBeenLastCalledWith("idle");
    await client.disconnect();
    expect(audio.stop).toHaveBeenCalledTimes(1);
  });

  it("stops streams from a permission prompt that resolves after leaving the room", async () => {
    let resolveStream: (stream: FakeStream) => void = () => { throw new Error("not initialized"); };
    getUserMedia.mockImplementation(() => new Promise<FakeStream>((resolve) => { resolveStream = resolve; }));
    const events = callbacks();
    const client = createRtcClient({ provider: "demo" }, events);
    const connecting = client.connect();
    await client.disconnect();
    const track = new FakeTrack("video");
    resolveStream(new FakeStream([track]));
    await connecting;
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(events.onState).not.toHaveBeenCalledWith("connected");
    expect(events.onTracks).toHaveBeenLastCalledWith([]);
  });

  it("reports a denied permission instead of claiming a media connection", async () => {
    const denied = Object.assign(new Error("secret browser detail"), { name: "NotAllowedError" });
    getUserMedia.mockRejectedValue(denied);
    const events = callbacks();
    const client = createRtcClient({ provider: "demo" }, events);
    await expect(client.connect()).rejects.toBe(denied);
    expect(events.onState).toHaveBeenLastCalledWith("permission-denied", expect.stringContaining("文字答疑仍可使用"));
    expect(events.onState).not.toHaveBeenCalledWith("connected");
    expect(mediaErrorMessage(denied)).not.toContain("secret browser detail");
  });

  it("rejects unavailable or insecure device access clearly", async () => {
    vi.stubGlobal("isSecureContext", false);
    const events = callbacks();
    await expect(createRtcClient({ provider: "demo" }, events).connect()).rejects.toThrow("HTTPS 或 localhost");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(events.onState).toHaveBeenLastCalledWith("failed", expect.stringContaining("HTTPS 或 localhost"));
    expect(mediaErrorMessage({ name: "NotFoundError" })).toContain("未找到");
  });

  it("passes only server-issued credentials to the SDK and stops local tracks on disconnect", async () => {
    const events = callbacks();
    const stop = vi.fn();
    livekit.room.localParticipant.trackPublications.set("camera", { track: { stop } });
    const client = createRtcClient({ provider: "livekit", url: "wss://rtc.example.test", token: "server-issued-token" }, events);
    await client.connect({ microphone: true, camera: false });
    expect(livekit.room.connect).toHaveBeenCalledWith("wss://rtc.example.test", "server-issued-token");
    expect(livekit.room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    expect(livekit.room.localParticipant.setCameraEnabled).toHaveBeenCalledWith(false);
    expect(events.onState).toHaveBeenLastCalledWith("connected");
    await client.disconnect();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(livekit.room.disconnect).toHaveBeenCalledWith(true);
    expect(events.onTracks).toHaveBeenLastCalledWith([]);
  });

  it("rejects missing LiveKit credentials without a false connected state", () => {
    expect(() => createRtcClient({ provider: "livekit", url: "", token: "" }, callbacks())).toThrow("配置不完整");
  });
});
