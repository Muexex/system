import { createHash } from "node:crypto";
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { db } from "./db";
import { domain } from "./domain";
import { HttpError, rateLimit } from "./security";

export type RtcAccess = { provider: "demo" } | {
  provider: "livekit"; url: string; token: string; roomName: string;
};

export function rtcRoomName(sessionId: string) {
  return `yanban-${sessionId}`;
}

function livekitConfiguration() {
  const provider = process.env.RTC_PROVIDER || "demo";
  if (provider === "demo") return null;
  if (provider !== "livekit") throw new HttpError(503, "音视频服务配置无效，文字答疑仍可使用。", "RTC_CONFIGURATION");
  const url = process.env.LIVEKIT_URL;
  const key = process.env.LIVEKIT_API_KEY;
  const secret = process.env.LIVEKIT_API_SECRET;
  if (!url || !key || !secret) {
    throw new HttpError(503, "音视频服务配置不完整，文字答疑仍可使用。", "RTC_CONFIGURATION");
  }
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new HttpError(503, "音视频服务地址无效。", "RTC_CONFIGURATION"); }
  if (!["wss:", "ws:", "https:", "http:"].includes(parsed.protocol)
    || parsed.username || parsed.password) {
    throw new HttpError(503, "音视频服务地址无效。", "RTC_CONFIGURATION");
  }
  return { url, key, secret };
}

export async function issueRtcAccess(userId: string, sessionId: string): Promise<RtcAccess> {
  await rateLimit(`rtc:${userId}`, 30);
  const session = await domain.authorizeSession(userId, sessionId);
  if (session.endedAt) throw new HttpError(409, "答疑已结束，无法进入音视频房间。", "SESSION_ENDED");
  const configuration = livekitConfiguration();
  if (!configuration) return { provider: "demo" };
  const roomName = rtcRoomName(session.id);
  const identity = `participant-${createHash("sha256").update(`${session.id}:${userId}`).digest("hex").slice(0, 32)}`;
  const accessToken = new AccessToken(configuration.key, configuration.secret, {
    identity, ttl: "5m",
  });
  accessToken.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canPublishSources: [TrackSource.MICROPHONE, TrackSource.CAMERA],
    canSubscribe: true,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
  const token = await accessToken.toJwt();
  // Signing is asynchronous; recheck the database to close an end/signing race.
  const fresh = await db.answerSession.findUnique({ where: { id: session.id }, select: { endedAt: true } });
  if (!fresh || fresh.endedAt) throw new HttpError(409, "答疑已结束，无法进入音视频房间。", "SESSION_ENDED");
  return { provider: "livekit", url: configuration.url, token, roomName };
}

export async function cleanupRtcRoom(sessionId: string) {
  const session = await db.answerSession.findUnique({ where: { id: sessionId } });
  if (!session?.endedAt || session.rtcCleanupStatus === "DONE") return;
  const now = new Date();
  // A persisted conditional claim prevents overlapping pollers from cleaning repeatedly.
  const claimed = await db.answerSession.updateMany({
    where: {
      id: sessionId,
      endedAt: { not: null },
      rtcCleanupStatus: { not: "DONE" },
      OR: [
        { rtcCleanupLastAttemptAt: null },
        { rtcCleanupLastAttemptAt: { lt: new Date(now.getTime() - 30_000) } },
      ],
    },
    data: { rtcCleanupStatus: "PENDING", rtcCleanupLastAttemptAt: now },
  });
  if (!claimed.count) return;
  try {
    const configuration = livekitConfiguration();
    if (configuration) {
      const serverUrl = configuration.url.replace(/^wss:/, "https:").replace(/^ws:/, "http:");
      const client = new RoomServiceClient(serverUrl, configuration.key, configuration.secret, {
        requestTimeout: 1, failover: false,
      });
      try {
        // Deleting a room actively removes connected participants, unlike token expiration.
        await client.deleteRoom(rtcRoomName(session.id));
      } catch (error) {
        // Deleting an already absent room is a successful idempotent cleanup.
        if (!(error && typeof error === "object" && "code" in error && error.code === "not_found")) throw error;
      }
    }
    await db.answerSession.updateMany({ where: { id: sessionId, endedAt: { not: null } }, data: { rtcCleanupStatus: "DONE" } });
  } catch {
    // No token, address with embedded credentials, or SDK diagnostic reaches logs/responses.
    await db.answerSession.updateMany({ where: { id: sessionId, endedAt: { not: null } }, data: { rtcCleanupStatus: "FAILED" } });
  }
}

export async function retryRtcCleanup() {
  const pending = await db.answerSession.findMany({
    where: {
      endedAt: { not: null }, rtcCleanupStatus: { in: ["PENDING", "FAILED"] },
      OR: [{ rtcCleanupLastAttemptAt: null }, { rtcCleanupLastAttemptAt: { lt: new Date(Date.now() - 30_000) } }],
    },
    orderBy: { endedAt: "asc" }, take: 3,
    select: { id: true },
  });
  for (const session of pending) await cleanupRtcRoom(session.id);
}
