import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/server/db";
import { createDomain } from "@/server/domain";
import { seedDatabase } from "../prisma/seed";
import { migratedTestDatabase } from "./isolated-db";

const problem = "请帮我解释这道考研数学极限题的推导过程，并说明适用条件。";
type Database = ReturnType<typeof createDb>;
type Service = ReturnType<typeof createDomain>;
let template: Awaited<ReturnType<typeof migratedTestDatabase>>;
let directory: string;
let database: Database;
let competingDatabase: Database;
let service: Service;
let competingService: Service;
let timestamp: number;
const advance = (ms: number) => { timestamp += ms; };

async function online(id = "answerer-a", subjects = ["math"]) {
  await service.updateAnswerer("admin", id, { enabled: true, subjectIds: subjects });
  await service.setPresence(id, true);
}

function request(input: Partial<Parameters<Service["createRequest"]>[1]> = {}, asker = "asker-a") {
  return service.createRequest(asker, {
    subjectId: "math", description: problem, mode: "DIRECT", targetAnswererId: "answerer-a",
    idempotencyKey: randomUUID(), ...input,
  });
}

async function pending(requestId: string) {
  const offer = await database.invitation.findFirst({ where: { requestId, status: "PENDING" } });
  expect(offer).not.toBeNull();
  return offer!;
}

async function room() {
  await online();
  const question = await request();
  const offer = await pending(question.id);
  const { sessionId } = await service.acceptOffer("answerer-a", offer.id);
  return { question, offer, sessionId };
}

beforeAll(async () => {
  template = await migratedTestDatabase();
  const initial = createDb(template.url);
  await seedDatabase(initial);
  await initial.$disconnect();
});

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "yanban-vitest-case-"));
  const file = join(directory, "test.db");
  await copyFile(template.file, file);
  database = createDb(`file:${file}`);
  competingDatabase = createDb(`file:${file}`);
  timestamp = Date.parse("2030-01-01T00:00:00.000Z");
  const options = {
    now: () => new Date(timestamp), waitMs: 1_000, offerMs: 200,
    heartbeatTtlMs: 500, abandonedMs: 2_000,
  };
  service = createDomain(database, options);
  competingService = createDomain(competingDatabase, options);
});

afterEach(async () => {
  await database?.$disconnect();
  await competingDatabase?.$disconnect();
  if (directory) await rm(directory, { recursive: true, force: true });
});
afterAll(async () => { await template?.cleanup(); });

describe("database-backed matching and presence", () => {
  it("seeds reproducibly, and every test answerer starts offline", async () => {
    await seedDatabase(database);
    await seedDatabase(database);
    expect(await database.user.count()).toBe(6);
    expect(await database.subject.count()).toBe(4);
    expect(await database.answererProfile.count({ where: { online: true } })).toBe(0);
  });

  it("matches the configured subject only and excludes expired heartbeats", async () => {
    await online("answerer-a", ["english"]);
    const unmatched = await request({ mode: "QUICK", targetAnswererId: undefined });
    expect(unmatched.status).toBe("WAITING");
    expect(await database.invitation.count()).toBe(0);
    await service.cancelRequest("asker-a", unmatched.id);
    await online("answerer-a", ["math"]);
    expect((await service.catalog()).onlineCount).toBe(1);
    advance(500);
    expect((await service.catalog()).onlineCount).toBe(0);
    const waiting = await request({ mode: "QUICK", targetAnswererId: undefined });
    expect(waiting.status).toBe("WAITING");
    expect(await database.answererLease.count()).toBe(0);
  });

  it("a heartbeat never brings an explicitly offline answerer online", async () => {
    await service.heartbeat("answerer-a");
    expect((await service.catalog()).onlineCount).toBe(0);
    await online();
    await service.setPresence("answerer-a", false);
    await service.heartbeat("answerer-a");
    expect((await service.catalog()).onlineCount).toBe(0);
  });

  it("only adult, non-employed full-time students are eligible for matching", async () => {
    await online();
    for (const invalid of [
      { isAdult: false, isFullTimeStudent: true, isEmployed: false },
      { isAdult: true, isFullTimeStudent: false, isEmployed: false },
      { isAdult: true, isFullTimeStudent: true, isEmployed: true },
    ]) {
      await database.answererProfile.update({ where: { userId: "answerer-a" }, data: invalid });
      await expect(request()).rejects.toMatchObject({ status: 409 });
      const waiting = await request({ mode: "QUICK", targetAnswererId: undefined });
      expect(waiting.status).toBe("WAITING");
      expect((await service.catalog()).onlineCount).toBe(0);
      await service.cancelRequest("asker-a", waiting.id);
    }
    expect(await database.invitation.count()).toBe(0);
  });

  it("two concurrent askers can reserve only one invitation on the same answerer", async () => {
    await online();
    const result = await Promise.allSettled([
      request({ mode: "QUICK", targetAnswererId: undefined }, "asker-a"),
      competingService.createRequest("asker-b", { subjectId: "math", description: problem,
        mode: "QUICK", idempotencyKey: randomUUID() }),
    ]);
    expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(2);
    expect(await database.answererLease.count()).toBe(1);
    expect(await database.invitation.count({ where: { status: "PENDING" } })).toBe(1);
    expect(await database.questionRequest.count({ where: { status: "OFFERED" } })).toBe(1);
    expect(await database.questionRequest.count({ where: { status: "WAITING" } })).toBe(1);
  });

  it("concurrent repeated submission and a retried request key create a single request", async () => {
    await online();
    const key = randomUUID();
    const [a, b] = await Promise.all([request({ idempotencyKey: key }),
      competingService.createRequest("asker-a", { subjectId: "math", description: problem,
        mode: "DIRECT", targetAnswererId: "answerer-a", idempotencyKey: key })]);
    expect(a.id).toBe(b.id);
    expect((await request({ idempotencyKey: key })).id).toBe(a.id);
    expect(await database.questionRequest.count()).toBe(1);
    expect(await database.requesterLease.count()).toBe(1);
    expect(await database.invitation.count()).toBe(1);
  });

  it("a second key cannot create a second active request for the same asker", async () => {
    await online();
    await request();
    await expect(request()).rejects.toMatchObject({ status: 409 });
    expect(await database.questionRequest.count()).toBe(1);
  });

  it("quick matching picks longest-idle first, then stable user id for a tie", async () => {
    await online("answerer-b");
    advance(10);
    await online("answerer-a");
    const question = await request({ mode: "QUICK", targetAnswererId: undefined });
    expect((await pending(question.id)).answererId).toBe("answerer-b");
    await service.cancelRequest("asker-a", question.id);
    await database.answererProfile.updateMany({ data: { idleSince: new Date(timestamp) } });
    const tied = await request({ mode: "QUICK", targetAnswererId: undefined });
    expect((await pending(tied.id)).answererId).toBe("answerer-a");
  });

  it("direct rejection terminates without silently inviting another answerer", async () => {
    await online();
    await online("answerer-b");
    const question = await request();
    const offer = await pending(question.id);
    await service.rejectOffer("answerer-a", offer.id);
    await service.rejectOffer("answerer-a", offer.id);
    expect((await service.getRequest("asker-a", question.id)).status).toBe("DECLINED");
    expect(await database.invitation.count()).toBe(1);
    expect(await database.answererLease.count()).toBe(0);
    expect(await database.requesterLease.count()).toBe(0);
  });

  it("quick matching does not repeat rejected or timed out answerers", async () => {
    await online();
    advance(10);
    await online("answerer-b");
    const question = await request({ mode: "QUICK", targetAnswererId: undefined });
    const first = await pending(question.id);
    expect(first.answererId).toBe("answerer-a");
    await service.rejectOffer("answerer-a", first.id);
    const second = await pending(question.id);
    expect(second.answererId).toBe("answerer-b");
    advance(201);
    await service.getRequest("asker-a", question.id);
    await service.getRequest("asker-a", question.id);
    expect(await database.invitation.count()).toBe(2);
    expect(await database.invitation.count({ where: { status: "PENDING" } })).toBe(0);
    expect(await database.answererLease.count()).toBe(0);
  });

  it("server time expires requests even after recreating the service", async () => {
    const question = await request({ mode: "QUICK", targetAnswererId: undefined });
    advance(1_001);
    service = createDomain(database, { now: () => new Date(timestamp), waitMs: 1_000, offerMs: 200, heartbeatTtlMs: 500 });
    expect((await service.getRequest("asker-a", question.id)).status).toBe("EXPIRED");
    expect(await database.requesterLease.count()).toBe(0);
  });
});

describe("transactional state races and room lifecycle", () => {
  it("accept versus cancel has exactly one legal outcome and no ghost room", async () => {
    await online();
    const question = await request();
    const offer = await pending(question.id);
    const result = await Promise.allSettled([
      service.acceptOffer("answerer-a", offer.id),
      competingService.cancelRequest("asker-a", question.id),
    ]);
    expect(result.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const final = await database.questionRequest.findUniqueOrThrow({ where: { id: question.id } });
    expect(["MATCHED", "CANCELLED"]).toContain(final.status);
    const matched = final.status === "MATCHED";
    expect(await database.answerSession.count()).toBe(matched ? 1 : 0);
    expect(await database.answererLease.count()).toBe(matched ? 1 : 0);
    expect(await database.requesterLease.count()).toBe(matched ? 1 : 0);
  });

  it("accept versus reject cannot create a declined request with an active room", async () => {
    await online();
    const question = await request();
    const offer = await pending(question.id);
    await Promise.allSettled([
      service.acceptOffer("answerer-a", offer.id), competingService.rejectOffer("answerer-a", offer.id),
    ]);
    const final = await database.questionRequest.findUniqueOrThrow({ where: { id: question.id } });
    expect(["MATCHED", "DECLINED"]).toContain(final.status);
    expect(await database.answerSession.count()).toBe(final.status === "MATCHED" ? 1 : 0);
    expect(await database.answererLease.count()).toBe(final.status === "MATCHED" ? 1 : 0);
  });

  it("duplicate concurrent acceptance creates exactly one session", async () => {
    await online();
    const question = await request();
    const offer = await pending(question.id);
    const [a, b] = await Promise.all([
      service.acceptOffer("answerer-a", offer.id), competingService.acceptOffer("answerer-a", offer.id),
    ]);
    expect(a.sessionId).toBe(b.sessionId);
    expect(await database.answerSession.count()).toBe(1);
  });

  it("an expired invitation cannot be accepted; deadline processing releases its lease", async () => {
    await online();
    const question = await request();
    const offer = await pending(question.id);
    advance(201);
    await expect(service.acceptOffer("answerer-a", offer.id)).rejects.toMatchObject({ status: 409 });
    expect(await database.answerSession.count()).toBe(0);
    expect(await database.answererLease.count()).toBe(0);
  });

  it("cancellation is idempotent and cannot turn an expired request back into cancelled", async () => {
    const first = await request({ mode: "QUICK", targetAnswererId: undefined });
    await service.cancelRequest("asker-a", first.id);
    await service.cancelRequest("asker-a", first.id);
    expect((await service.getRequest("asker-a", first.id)).status).toBe("CANCELLED");
    const second = await request({ mode: "QUICK", targetAnswererId: undefined });
    advance(1_001);
    await service.cancelRequest("asker-a", second.id);
    expect((await service.getRequest("asker-a", second.id)).status).toBe("EXPIRED");
    expect(await database.requesterLease.count()).toBe(0);
  });

  it("starts timing only when both participants enter and refresh preserves start", async () => {
    const { sessionId } = await room();
    const first = await service.enterSession("asker-a", sessionId);
    expect(first.startedAt).toBeNull();
    advance(50);
    const second = await service.enterSession("answerer-a", sessionId);
    expect(second.startedAt!.getTime()).toBe(timestamp);
    advance(50);
    expect((await service.enterSession("asker-a", sessionId)).startedAt).toEqual(second.startedAt);
    expect((await service.getSession("answerer-a", sessionId)).startedAt).toEqual(second.startedAt);
    expect((await service.getRequest("asker-a", second.requestId)).status).toBe("IN_PROGRESS");
  });

  it("persists bidirectional messages and deduplicates retries by sender and client id", async () => {
    const { sessionId } = await room();
    await service.enterSession("asker-a", sessionId);
    await service.enterSession("answerer-a", sessionId);
    const message = await service.sendMessage("asker-a", sessionId, { body: "我的问题是极限计算", clientId: "outgoing-1" });
    const retried = await service.sendMessage("asker-a", sessionId, { body: "我的问题是极限计算", clientId: "outgoing-1" });
    expect(retried.id).toBe(message.id);
    advance(1);
    await service.sendMessage("answerer-a", sessionId, { body: "可以先尝试洛必达法则", clientId: "outgoing-1" });
    const recovered = await service.getSession("asker-a", sessionId);
    expect(recovered.messages.map((x) => x.body)).toEqual(["我的问题是极限计算", "可以先尝试洛必达法则"]);
    expect(await database.message.count()).toBe(2);
  });

  it("end is idempotent and a later retry never releases a different request's lease", async () => {
    const { sessionId } = await room();
    await service.enterSession("asker-a", sessionId);
    await service.enterSession("answerer-a", sessionId);
    const first = await service.endSession("asker-a", sessionId);
    advance(20);
    const second = await service.endSession("answerer-a", sessionId);
    expect(second.endedAt).toEqual(first.endedAt);
    expect(await database.answererLease.count()).toBe(0);
    expect(await database.requesterLease.count()).toBe(0);
    const next = await request({}, "asker-b");
    const nextLease = await database.answererLease.findUniqueOrThrow({ where: { answererId: "answerer-a" } });
    expect(nextLease.requestId).toBe(next.id);
    await service.endSession("asker-a", sessionId);
    expect((await database.answererLease.findUniqueOrThrow({ where: { answererId: "answerer-a" } })).requestId).toBe(next.id);
  });

  it("short disconnects preserve a room, while long inactivity is separately reclaimed", async () => {
    const { sessionId } = await room();
    await service.enterSession("asker-a", sessionId);
    await service.enterSession("answerer-a", sessionId);
    advance(501);
    expect((await service.getSession("asker-a", sessionId)).endedAt).toBeNull();
    advance(2_001);
    const reclaimed = await service.getSession("asker-a", sessionId);
    expect(reclaimed.endedAt).not.toBeNull();
    expect(reclaimed.endReason).not.toBe("USER_ENDED");
    expect(await database.answererLease.count()).toBe(0);
  });
});

describe("authorization, ended-room rules and real reporting", () => {
  it("non-participants cannot read or enter rooms or write messages", async () => {
    const { sessionId, question } = await room();
    await expect(service.getRequest("asker-b", question.id)).rejects.toMatchObject({ status: 403 });
    await expect(service.getSession("asker-b", sessionId)).rejects.toMatchObject({ status: 403 });
    await expect(service.enterSession("answerer-b", sessionId)).rejects.toMatchObject({ status: 403 });
    await expect(service.sendMessage("asker-b", sessionId, { body: "侵入消息", clientId: randomUUID() })).rejects.toMatchObject({ status: 403 });
    await expect(service.endSession("admin", sessionId)).rejects.toMatchObject({ status: 403 });
    expect(await database.message.count()).toBe(0);
  });

  it("non-admins cannot read statistics or edit answerer profiles", async () => {
    await expect(service.adminData("asker-a")).rejects.toMatchObject({ status: 403 });
    await expect(service.updateAnswerer("answerer-a", "answerer-b", { enabled: false, subjectIds: [] })).rejects.toMatchObject({ status: 403 });
    expect((await database.answererProfile.findUniqueOrThrow({ where: { userId: "answerer-b" } })).enabled).toBe(true);
  });

  it("ended rooms reject new messages and RTC authorization", async () => {
    const { sessionId } = await room();
    await service.endSession("asker-a", sessionId);
    await expect(service.sendMessage("asker-a", sessionId, { body: "结束后发送", clientId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    await expect(service.authorizeSession("answerer-a", sessionId)).rejects.toMatchObject({ status: 409 });
    expect(await database.message.count()).toBe(0);
  });

  it("feedback requires ended participation and repeated submissions yield one record", async () => {
    const { sessionId } = await room();
    const payload = { resolution: "SOLVED", rating: 5, comment: "推导清楚" };
    await expect(service.feedback("asker-a", sessionId, payload)).rejects.toMatchObject({ status: 409 });
    await service.endSession("answerer-a", sessionId);
    await expect(service.feedback("asker-b", sessionId, payload)).rejects.toMatchObject({ status: 403 });
    await expect(service.feedback("answerer-a", sessionId, payload)).rejects.toMatchObject({ status: 403 });
    const [first, second] = await Promise.all([
      service.feedback("asker-a", sessionId, payload), competingService.feedback("asker-a", sessionId, payload),
    ]);
    expect(first.id).toBe(second.id);
    expect(await database.feedback.count()).toBe(1);
    const stats = (await service.adminData("admin")).stats;
    expect(stats.requestCount).toBe(1);
    expect(stats.matchedCount).toBe(1);
    expect(stats.completedCount).toBe(1);
    expect(stats.feedbackCount).toBe(1);
    expect(stats.solvedRatio).toBe(1);
    expect(stats.bySubject.find((x) => x.id === "math")?.count).toBe(1);
    expect((await service.history("asker-b"))).toHaveLength(0);
    expect((await service.history("asker-a"))).toHaveLength(1);
  });
});
