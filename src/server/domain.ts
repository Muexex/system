import { Prisma, PrismaClient } from '../generated/prisma/client';
import { config, type DomainConfig } from './config';
import { db } from './db';
import { DomainError, fail } from './errors';

type Tx = Prisma.TransactionClient;
export type DomainOptions = Partial<DomainConfig> & { now?: () => Date };
export type CreateRequestInput = {
  subjectId: string; description: string; mode: 'DIRECT' | 'QUICK';
  targetAnswererId?: string; attachmentId?: string; idempotencyKey: string;
};
const active = ['WAITING', 'OFFERED', 'MATCHED', 'IN_PROGRESS'];
const requestInclude = { subject: true, session: { select: { id: true } } } as const;
const profileInclude = { user: true, subjects: { include: { subject: true } }, lease: true } as const;
const roomInclude = {
  asker: true, answerer: true, request: { include: requestInclude },
  messages: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }, feedback: true,
} satisfies Prisma.AnswerSessionInclude;
type FullRequest = Prisma.QuestionRequestGetPayload<{ include: typeof requestInclude }>;
type FullProfile = Prisma.AnswererProfileGetPayload<{ include: typeof profileInclude }>;
type FullRoom = Prisma.AnswerSessionGetPayload<{ include: typeof roomInclude }>;

function publicUser(user: { id: string; name: string; role: string }) {
  return { id: user.id, name: user.name, role: user.role };
}
function requestView(request: FullRequest) {
  return {
    id: request.id, askerId: request.askerId, subjectId: request.subjectId, subject: request.subject,
    description: request.description, mode: request.mode, status: request.status,
    createdAt: request.createdAt, deadlineAt: request.deadlineAt, matchedAt: request.matchedAt,
    targetAnswererId: request.targetAnswererId, attachmentId: request.attachmentId,
    sessionId: request.session?.id ?? null, endReason: request.endReason,
  };
}
function roomView(room: FullRoom) {
  return {
    id: room.id, requestId: room.requestId, askerId: room.askerId, answererId: room.answererId,
    asker: publicUser(room.asker), answerer: publicUser(room.answerer), request: requestView(room.request),
    startedAt: room.startedAt, endedAt: room.endedAt, endReason: room.endReason,
    messages: room.messages.map(m => ({ id: m.id, senderId: m.senderId, body: m.body, clientId: m.clientId, createdAt: m.createdAt })),
    feedback: room.feedback,
  };
}
function text(value: unknown, label: string, min: number, max: number) {
  if (typeof value !== 'string') fail(`${label}格式不正确`);
  const result = value.trim();
  if (Array.from(result).length < min || Array.from(result).length > max) fail(`${label}须为${min}—${max}字`);
  return result;
}
function isBusy(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String(error.code) : '';
  return ['P1008', 'P2034'].includes(code) || /SQLITE_BUSY|database is locked|write conflict|operation has timed out|Transaction.*timed out/i.test(error.message);
}

export class Domain {
  readonly settings: DomainConfig;
  private readonly now: () => Date;
  constructor(readonly client: PrismaClient, options: DomainOptions = {}) {
    const { now, ...overrides } = options;
    this.settings = { ...config, ...overrides };
    this.now = now ?? (() => new Date());
  }
  /** SQLite serializes writers. The first write takes the database lock before any state reads.
   * Leases and unique keys are also database-enforced, and all transitions share this transaction. */
  private async transaction<T>(work: (tx: Tx, now: Date) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const outcome = await this.client.$transaction(async tx => {
          await tx.writeFence.upsert({ where: { id: 1 }, create: { id: 1, revision: 1 }, update: { revision: { increment: 1 } } });
          const now = this.now();
          await this.repair(tx, now);
          // Keep maintenance committed when a stale operation is rejected, but never commit a
          // partially applied operation. The SQLite savepoint scopes rollback to the user action.
          await tx.$executeRawUnsafe('SAVEPOINT domain_action');
          try {
            const value = await work(tx, now);
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT domain_action');
            return { ok: true as const, value };
          } catch (error) {
            if (!(error instanceof DomainError)) throw error;
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT domain_action');
            await tx.$executeRawUnsafe('RELEASE SAVEPOINT domain_action');
            return { ok: false as const, error };
          }
        }, { maxWait: 10_000, timeout: 15_000 });
        if (!outcome.ok) throw outcome.error;
        return outcome.value;
      } catch (error) {
        if (!isBusy(error) || attempt >= 8) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(25 * (attempt + 1), 200)));
      }
    }
  }
  private async user(tx: Tx, id: string, role?: string) {
    const user = await tx.user.findUnique({ where: { id } });
    if (!user) fail('请先登录', 401, 'UNAUTHENTICATED');
    if (role && user.role !== role) fail('当前账号没有操作权限', 403, 'FORBIDDEN');
    return user;
  }
  private async event(tx: Tx, kind: string, now: Date, refs: { requestId?: string; sessionId?: string; actorId?: string; detail?: string } = {}) {
    await tx.businessEvent.create({ data: { kind, createdAt: now, ...refs } });
  }
  private async release(tx: Tx, requestId: string, now: Date, sessionId?: string, offerId?: string) {
    const leases = await tx.answererLease.findMany({ where: { requestId, ...(sessionId ? { sessionId } : {}), ...(offerId ? { offerId } : {}) } });
    await tx.answererLease.deleteMany({ where: { requestId, ...(sessionId ? { sessionId } : {}), ...(offerId ? { offerId } : {}) } });
    for (const lease of leases) await tx.answererProfile.update({ where: { userId: lease.answererId }, data: { idleSince: now } });
  }
  private async terminateRequest(tx: Tx, requestId: string, status: string, reason: string, now: Date, actorId?: string) {
    const changed = await tx.questionRequest.updateMany({ where: { id: requestId, status: { in: ['WAITING', 'OFFERED'] } }, data: { status, endReason: reason } });
    if (!changed.count) return;
    await tx.invitation.updateMany({ where: { requestId, status: 'PENDING' }, data: { status: status === 'EXPIRED' ? 'EXPIRED' : 'CANCELLED', decidedAt: now } });
    await this.release(tx, requestId, now);
    await tx.requesterLease.deleteMany({ where: { requestId } });
    await this.event(tx, status, now, { requestId, actorId, detail: reason });
  }
  private async finishSession(tx: Tx, session: { id: string; requestId: string; endedAt: Date | null }, now: Date, reason: string, actorId?: string) {
    const changed = await tx.answerSession.updateMany({ where: { id: session.id, endedAt: null }, data: { endedAt: now, endReason: reason, rtcCleanupStatus: 'PENDING' } });
    if (!changed.count) return;
    await tx.questionRequest.updateMany({ where: { id: session.requestId, status: { in: ['MATCHED', 'IN_PROGRESS'] } }, data: { status: reason === 'ABANDONED' ? 'CANCELLED' : 'COMPLETED', endReason: reason } });
    await this.release(tx, session.requestId, now, session.id);
    await tx.requesterLease.deleteMany({ where: { requestId: session.requestId } });
    await this.event(tx, reason === 'ABANDONED' ? 'SESSION_ABANDONED' : 'SESSION_ENDED', now, { requestId: session.requestId, sessionId: session.id, actorId, detail: reason });
  }
  private async repair(tx: Tx, now: Date) {
    const timedOut = await tx.questionRequest.findMany({ where: { status: { in: ['WAITING', 'OFFERED'] }, deadlineAt: { lte: now } } });
    for (const request of timedOut) await this.terminateRequest(tx, request.id, 'EXPIRED', 'MATCH_TIMEOUT', now);
    const offers = await tx.invitation.findMany({ where: { status: 'PENDING', deadlineAt: { lte: now } }, include: { request: true } });
    for (const offer of offers) {
      const changed = await tx.invitation.updateMany({ where: { id: offer.id, status: 'PENDING' }, data: { status: 'EXPIRED', decidedAt: now } });
      if (!changed.count) continue;
      await this.release(tx, offer.requestId, now, undefined, offer.id);
      if (offer.request.mode === 'DIRECT') await this.terminateRequest(tx, offer.requestId, 'EXPIRED', 'OFFER_TIMEOUT', now);
      else await tx.questionRequest.updateMany({ where: { id: offer.requestId, status: 'OFFERED' }, data: { status: 'WAITING' } });
      await this.event(tx, 'OFFER_EXPIRED', now, { requestId: offer.requestId });
    }
    const sessions = await tx.answerSession.findMany({ where: { endedAt: null } });
    for (const session of sessions) {
      const lastSeen = Math.max(session.createdAt.getTime(), session.askerSeenAt?.getTime() ?? 0, session.answererSeenAt?.getTime() ?? 0);
      if (lastSeen + this.settings.abandonedMs <= now.getTime()) await this.finishSession(tx, session, now, 'ABANDONED');
    }
    // Recover leftovers after a service restart or interrupted maintenance. Conditions bind a release
    // to its exact request/session, so it cannot delete a newer user's lease.
    const stale = await tx.answererLease.findMany({ where: { request: { status: { notIn: active } } } });
    for (const lease of stale) await this.release(tx, lease.requestId, now, lease.sessionId ?? undefined, lease.offerId ?? undefined);
    await tx.requesterLease.deleteMany({ where: { request: { status: { notIn: active } } } });
    await this.schedule(tx, now);
  }
  private available(now: Date) {
    return { enabled: true, isAdult: true, isFullTimeStudent: true, isEmployed: false, online: true, heartbeatAt: { gt: new Date(now.getTime() - this.settings.heartbeatTtlMs) }, lease: { is: null } };
  }
  private async schedule(tx: Tx, now: Date) {
    const requests = await tx.questionRequest.findMany({ where: { status: 'WAITING', deadlineAt: { gt: now } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    for (const request of requests) {
      const tried = await tx.invitation.findMany({ where: { requestId: request.id }, select: { answererId: true } });
      const excluded = [request.askerId, ...tried.map(i => i.answererId)];
      const profile = await tx.answererProfile.findFirst({
        where: { ...this.available(now), userId: request.mode === 'DIRECT' ? { equals: request.targetAnswererId ?? '', notIn: excluded } : { notIn: excluded }, subjects: { some: { subjectId: request.subjectId } } },
        orderBy: [{ idleSince: 'asc' }, { userId: 'asc' }],
      });
      if (!profile) continue;
      const deadlineAt = new Date(Math.min(now.getTime() + this.settings.offerMs, request.deadlineAt.getTime()));
      const invitation = await tx.invitation.create({ data: { requestId: request.id, answererId: profile.userId, status: 'PENDING', createdAt: now, deadlineAt } });
      await tx.answererLease.create({ data: { answererId: profile.userId, requestId: request.id, offerId: invitation.id, expiresAt: deadlineAt } });
      const changed = await tx.questionRequest.updateMany({ where: { id: request.id, status: 'WAITING' }, data: { status: 'OFFERED' } });
      if (!changed.count) fail('请求状态已变化，请重试', 409, 'STATE_CONFLICT');
      await this.event(tx, 'OFFERED', now, { requestId: request.id, detail: invitation.id });
    }
  }
  private card(profile: FullProfile, now: Date) {
    const live = profile.enabled && profile.isAdult && profile.isFullTimeStudent && !profile.isEmployed && profile.online && !!profile.heartbeatAt && profile.heartbeatAt.getTime() + this.settings.heartbeatTtlMs > now.getTime();
    return { id: profile.userId, name: profile.user.name, bio: profile.bio, enabled: profile.enabled, online: live, subjects: profile.subjects.map(s => s.subject), status: !live ? 'OFFLINE' : profile.lease ? 'BUSY' : 'AVAILABLE' };
  }
  async reconcile() { return this.transaction(async () => undefined); }
  async catalog() {
    return this.transaction(async (tx, now) => {
      const subjects = await tx.subject.findMany({ orderBy: { id: 'asc' } });
      const profiles = await tx.answererProfile.findMany({ where: { enabled: true }, include: profileInclude, orderBy: { userId: 'asc' } });
      const answerers = profiles.map(p => this.card(p, now));
      return { subjects, answerers, onlineCount: answerers.filter(a => a.status !== 'OFFLINE').length, config: { waitMs: this.settings.waitMs, offerMs: this.settings.offerMs, heartbeatMs: this.settings.heartbeatMs, pollMs: this.settings.pollMs } };
    });
  }
  async createRequest(userId: string, input: CreateRequestInput) {
    const description = text(input.description, '问题描述', 20, 2000);
    const idempotencyKey = text(input.idempotencyKey, '请求标识', 8, 128);
    if (!['DIRECT', 'QUICK'].includes(input.mode)) fail('请选择有效的匹配方式');
    return this.transaction(async (tx, now) => {
      await this.user(tx, userId, 'ASKER');
      const previous = await tx.questionRequest.findUnique({ where: { askerId_idempotencyKey: { askerId: userId, idempotencyKey } }, include: requestInclude });
      if (previous) {
        if (previous.subjectId !== input.subjectId || previous.description !== description || previous.mode !== input.mode || (previous.targetAnswererId ?? null) !== (input.targetAnswererId ?? null) || (previous.attachmentId ?? null) !== (input.attachmentId ?? null)) fail('该请求标识已用于其他问题', 409, 'IDEMPOTENCY_CONFLICT');
        return requestView(previous);
      }
      if (await tx.requesterLease.findUnique({ where: { askerId: userId } })) fail('您已有一个未结束的请求，请先处理', 409, 'ACTIVE_REQUEST');
      if (!await tx.subject.findUnique({ where: { id: input.subjectId } })) fail('科目不存在');
      if (input.mode === 'DIRECT') {
        if (!input.targetAnswererId || input.targetAnswererId === userId) fail('请选择有效的答疑者');
        const target = await tx.answererProfile.findFirst({ where: { userId: input.targetAnswererId, ...this.available(now), subjects: { some: { subjectId: input.subjectId } } } });
        if (!target) fail('该答疑者当前不可接单或不支持所选科目', 409, 'ANSWERER_UNAVAILABLE');
      }
      if (input.attachmentId) {
        const attachment = await tx.attachment.findUnique({ where: { id: input.attachmentId }, include: { request: true } });
        if (!attachment || attachment.uploaderId !== userId || attachment.request) fail('图片不存在、无权限或已用于其他请求', 403, 'INVALID_ATTACHMENT');
      }
      const request = await tx.questionRequest.create({ data: { askerId: userId, subjectId: input.subjectId, description, mode: input.mode, targetAnswererId: input.mode === 'DIRECT' ? input.targetAnswererId : null, attachmentId: input.attachmentId, idempotencyKey, createdAt: now, deadlineAt: new Date(now.getTime() + this.settings.waitMs) } });
      await tx.requesterLease.create({ data: { askerId: userId, requestId: request.id } });
      await this.event(tx, 'REQUEST_CREATED', now, { requestId: request.id, actorId: userId });
      await this.schedule(tx, now);
      return requestView(await tx.questionRequest.findUniqueOrThrow({ where: { id: request.id }, include: requestInclude }));
    });
  }
  async getRequest(userId: string, requestId: string) {
    return this.transaction(async tx => {
      await this.user(tx, userId);
      const request = await tx.questionRequest.findUnique({ where: { id: requestId }, include: { ...requestInclude, invitations: { where: { answererId: userId } } } });
      if (!request) fail('请求不存在', 404, 'NOT_FOUND');
      if (request.askerId !== userId && !request.invitations.length) fail('无权查看此请求', 403, 'FORBIDDEN');
      return requestView(request);
    });
  }
  async cancelRequest(userId: string, requestId: string) {
    return this.transaction(async (tx, now) => {
      const request = await tx.questionRequest.findUnique({ where: { id: requestId } });
      if (!request) fail('请求不存在', 404, 'NOT_FOUND');
      if (request.askerId !== userId) fail('无权取消此请求', 403, 'FORBIDDEN');
      if (['MATCHED', 'IN_PROGRESS', 'COMPLETED'].includes(request.status)) fail('请求已被接受，请在答疑室结束答疑', 409, 'STATE_CONFLICT');
      if (['WAITING', 'OFFERED'].includes(request.status)) await this.terminateRequest(tx, request.id, 'CANCELLED', 'USER_CANCELLED', now, userId);
      await this.schedule(tx, now);
      return requestView(await tx.questionRequest.findUniqueOrThrow({ where: { id: requestId }, include: requestInclude }));
    });
  }
  async setPresence(userId: string, online: boolean) {
    if (typeof online !== 'boolean') fail('上线状态格式无效');
    return this.transaction(async (tx, now) => {
      await this.user(tx, userId, 'ANSWERER');
      const profile = await tx.answererProfile.findUnique({ where: { userId } });
      if (!profile) fail('答疑者资料不存在', 404);
      if (online && !profile.enabled) fail('该测试答疑者已停用', 403, 'DISABLED');
      const wasLive = profile.online && profile.heartbeatAt && profile.heartbeatAt.getTime() + this.settings.heartbeatTtlMs > now.getTime();
      await tx.answererProfile.update({ where: { userId }, data: { online, heartbeatAt: online ? now : null, ...(online && !wasLive ? { idleSince: now } : {}) } });
      // Voluntary offline releases a pending invitation, but never completes an ongoing session.
      if (!online) {
        const offers = await tx.invitation.findMany({ where: { answererId: userId, status: 'PENDING' }, include: { request: true } });
        for (const offer of offers) await this.decideRejection(tx, offer, now, userId, 'OFFLINE');
      }
      await this.schedule(tx, now);
      return this.card(await tx.answererProfile.findUniqueOrThrow({ where: { userId }, include: profileInclude }), now);
    });
  }
  async heartbeat(userId: string) {
    return this.transaction(async (tx, now) => {
      await this.user(tx, userId, 'ANSWERER');
      await tx.answererProfile.updateMany({ where: { userId, online: true, enabled: true }, data: { heartbeatAt: now } });
      await this.schedule(tx, now);
      return this.card(await tx.answererProfile.findUniqueOrThrow({ where: { userId }, include: profileInclude }), now);
    });
  }
  async answerDashboard(userId: string) {
    return this.transaction(async (tx, now) => {
      await this.user(tx, userId, 'ANSWERER');
      const profile = await tx.answererProfile.findUniqueOrThrow({ where: { userId }, include: profileInclude });
      const offers = await tx.invitation.findMany({ where: { answererId: userId, status: 'PENDING' }, include: { request: { include: requestInclude } }, orderBy: { createdAt: 'asc' } });
      const session = await tx.answerSession.findFirst({ where: { answererId: userId, endedAt: null }, include: roomInclude });
      return { profile: this.card(profile, now), subjects: profile.subjects.map(s => s.subject), offers: offers.map(o => ({ id: o.id, deadlineAt: o.deadlineAt, status: o.status, request: requestView(o.request) })), currentSession: session ? roomView(session) : null, history: await this.historyIn(tx, userId) };
    });
  }
  async acceptOffer(userId: string, offerId: string) {
    return this.transaction(async (tx, now) => {
      await this.user(tx, userId, 'ANSWERER');
      const offer = await tx.invitation.findUnique({ where: { id: offerId }, include: { request: { include: { session: true } }, profile: true } });
      if (!offer) fail('邀请不存在', 404, 'NOT_FOUND');
      if (offer.answererId !== userId) fail('无权接受此邀请', 403, 'FORBIDDEN');
      if (offer.status === 'ACCEPTED' && offer.request.session?.answererId === userId) return { sessionId: offer.request.session.id };
      const lease = await tx.answererLease.findUnique({ where: { answererId: userId } });
      if (offer.status !== 'PENDING' || offer.request.status !== 'OFFERED' || offer.deadlineAt <= now || offer.request.deadlineAt <= now || lease?.offerId !== offer.id) fail('邀请已失效', 409, 'STATE_CONFLICT');
      if (!offer.profile.enabled || !offer.profile.isAdult || !offer.profile.isFullTimeStudent || offer.profile.isEmployed || !offer.profile.online || !offer.profile.heartbeatAt || offer.profile.heartbeatAt.getTime() + this.settings.heartbeatTtlMs <= now.getTime()) fail('请重新上线后接单', 409, 'ANSWERER_OFFLINE');
      const changed = await tx.invitation.updateMany({ where: { id: offerId, status: 'PENDING', deadlineAt: { gt: now } }, data: { status: 'ACCEPTED', decidedAt: now } });
      if (!changed.count) fail('邀请已失效', 409, 'STATE_CONFLICT');
      await tx.questionRequest.updateMany({ where: { id: offer.requestId, status: 'OFFERED' }, data: { status: 'MATCHED', matchedAt: now } });
      const session = await tx.answerSession.create({ data: { requestId: offer.requestId, askerId: offer.request.askerId, answererId: userId, createdAt: now } });
      await tx.answererLease.update({ where: { answererId: userId }, data: { offerId: null, sessionId: session.id, expiresAt: null } });
      await this.event(tx, 'MATCHED', now, { requestId: offer.requestId, sessionId: session.id, actorId: userId });
      return { sessionId: session.id };
    });
  }
  private async decideRejection(tx: Tx, offer: { id: string; requestId: string; request: { mode: string } }, now: Date, userId: string, reason = 'REJECTED') {
    const changed = await tx.invitation.updateMany({ where: { id: offer.id, status: 'PENDING' }, data: { status: 'DECLINED', decidedAt: now } });
    if (!changed.count) return;
    await this.release(tx, offer.requestId, now, undefined, offer.id);
    if (offer.request.mode === 'DIRECT') await this.terminateRequest(tx, offer.requestId, 'DECLINED', reason, now, userId);
    else await tx.questionRequest.updateMany({ where: { id: offer.requestId, status: 'OFFERED' }, data: { status: 'WAITING' } });
    await this.event(tx, 'OFFER_DECLINED', now, { requestId: offer.requestId, actorId: userId, detail: reason });
  }
  async rejectOffer(userId: string, offerId: string) {
    return this.transaction(async (tx, now) => {
      await this.user(tx, userId, 'ANSWERER');
      const offer = await tx.invitation.findUnique({ where: { id: offerId }, include: { request: true } });
      if (!offer) fail('邀请不存在', 404, 'NOT_FOUND');
      if (offer.answererId !== userId) fail('无权拒绝此邀请', 403, 'FORBIDDEN');
      if (offer.status === 'ACCEPTED') fail('已接受邀请，请在答疑室结束', 409, 'STATE_CONFLICT');
      await this.decideRejection(tx, offer, now, userId);
      await this.schedule(tx, now);
      return { ok: true };
    });
  }
  private async member(tx: Tx, userId: string, sessionId: string) {
    const session = await tx.answerSession.findUnique({ where: { id: sessionId } });
    if (!session) fail('答疑室不存在', 404, 'NOT_FOUND');
    if (session.askerId !== userId && session.answererId !== userId) fail('无权查看此答疑室', 403, 'FORBIDDEN');
    return session;
  }
  async getSession(userId: string, sessionId: string) {
    return this.transaction(async (tx, now) => {
      const session = await this.member(tx, userId, sessionId);
      if (!session.endedAt) await tx.answerSession.update({ where: { id: sessionId }, data: session.askerId === userId ? { askerSeenAt: now } : { answererSeenAt: now } });
      return roomView(await tx.answerSession.findUniqueOrThrow({ where: { id: sessionId }, include: roomInclude }));
    });
  }
  async enterSession(userId: string, sessionId: string) {
    return this.transaction(async (tx, now) => {
      let session = await this.member(tx, userId, sessionId);
      if (session.endedAt) return roomView(await tx.answerSession.findUniqueOrThrow({ where: { id: sessionId }, include: roomInclude }));
      const data = session.askerId === userId ? { askerSeenAt: now, ...(session.askerEnteredAt ? {} : { askerEnteredAt: now }) } : { answererSeenAt: now, ...(session.answererEnteredAt ? {} : { answererEnteredAt: now }) };
      session = await tx.answerSession.update({ where: { id: sessionId }, data });
      if (!session.startedAt && session.askerEnteredAt && session.answererEnteredAt) {
        await tx.answerSession.updateMany({ where: { id: sessionId, startedAt: null, endedAt: null }, data: { startedAt: now } });
        await tx.questionRequest.updateMany({ where: { id: session.requestId, status: 'MATCHED' }, data: { status: 'IN_PROGRESS' } });
        await this.event(tx, 'SESSION_STARTED', now, { requestId: session.requestId, sessionId, actorId: userId });
      }
      return roomView(await tx.answerSession.findUniqueOrThrow({ where: { id: sessionId }, include: roomInclude }));
    });
  }
  async endSession(userId: string, sessionId: string) {
    return this.transaction(async (tx, now) => {
      const session = await this.member(tx, userId, sessionId);
      await this.finishSession(tx, session, now, 'USER_ENDED', userId);
      await this.schedule(tx, now);
      return roomView(await tx.answerSession.findUniqueOrThrow({ where: { id: sessionId }, include: roomInclude }));
    });
  }
  async sendMessage(userId: string, sessionId: string, input: { body: string; clientId: string }) {
    const body = text(input.body, '消息', 1, 2000);
    const clientId = text(input.clientId, '消息标识', 8, 128);
    return this.transaction(async (tx, now) => {
      const session = await this.member(tx, userId, sessionId);
      if (session.endedAt) fail('答疑已结束，不能发送消息', 409, 'SESSION_ENDED');
      if (!session.startedAt) fail('等待双方进入答疑室后再发送消息', 409, 'SESSION_NOT_STARTED');
      const previous = await tx.message.findUnique({ where: { sessionId_senderId_clientId: { sessionId, senderId: userId, clientId } } });
      if (previous) {
        if (previous.body !== body) fail('该消息标识已用于其他内容', 409, 'IDEMPOTENCY_CONFLICT');
        return previous;
      }
      await tx.answerSession.update({ where: { id: sessionId }, data: session.askerId === userId ? { askerSeenAt: now } : { answererSeenAt: now } });
      return tx.message.create({ data: { sessionId, senderId: userId, body, clientId, createdAt: now } });
    });
  }
  async authorizeSession(userId: string, sessionId: string) {
    return this.transaction(async tx => {
      const session = await this.member(tx, userId, sessionId);
      if (session.endedAt) fail('答疑已结束，无法连接音视频', 409, 'SESSION_ENDED');
      return session;
    });
  }
  async authorizeAttachment(userId: string, attachmentId: string) {
    return this.transaction(async (tx, now) => {
      await this.user(tx, userId);
      const attachment = await tx.attachment.findUnique({ where: { id: attachmentId }, include: { request: { include: { session: true, invitations: { where: { answererId: userId, status: 'PENDING', deadlineAt: { gt: now } } } } } } });
      if (!attachment) fail('图片不存在', 404, 'NOT_FOUND');
      const request = attachment.request;
      const allowed = attachment.uploaderId === userId || request?.askerId === userId || request?.session?.answererId === userId || request?.session?.askerId === userId || (!!request && request.status === 'OFFERED' && request.invitations.length > 0);
      if (!allowed) fail('无权查看此图片', 403, 'FORBIDDEN');
      return attachment;
    });
  }
  async feedback(userId: string, sessionId: string, input: { resolution: string; rating: number; comment?: string }) {
    if (!['SOLVED', 'PARTIAL', 'UNSOLVED'].includes(input.resolution)) fail('请选择问题解决情况');
    if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) fail('满意度须为1—5分');
    const comment = input.comment === undefined ? '' : text(input.comment, '意见', 0, 500);
    return this.transaction(async (tx, now) => {
      const session = await this.member(tx, userId, sessionId);
      if (session.askerId !== userId) fail('只有提问者可以评价', 403, 'FORBIDDEN');
      if (!session.endedAt || session.endReason === 'ABANDONED') fail('答疑尚未完成，不能评价', 409, 'SESSION_NOT_COMPLETED');
      const previous = await tx.feedback.findUnique({ where: { sessionId } });
      if (previous) return previous;
      const feedback = await tx.feedback.create({ data: { sessionId, resolution: input.resolution, rating: input.rating, comment, createdAt: now } });
      await this.event(tx, 'FEEDBACK_CREATED', now, { requestId: session.requestId, sessionId, actorId: userId });
      return feedback;
    });
  }
  private async historyIn(tx: Tx, userId: string) {
    const requests = await tx.questionRequest.findMany({
      where: { OR: [{ askerId: userId }, { session: { answererId: userId } }, { invitations: { some: { answererId: userId } } }] },
      include: { subject: true, asker: true, session: { include: { answerer: true, feedback: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return requests.map(r => ({ id: r.session?.id ?? r.id, requestId: r.id, subject: r.subject, otherName: r.askerId === userId ? r.session?.answerer.name ?? '尚未匹配' : r.asker.name, status: r.status, createdAt: r.createdAt, startedAt: r.session?.startedAt ?? null, endedAt: r.session?.endedAt ?? null, sessionId: r.session && (r.session.askerId === userId || r.session.answererId === userId) ? r.session.id : null, feedback: r.session && (r.session.askerId === userId || r.session.answererId === userId) ? r.session.feedback : null, description: r.description, endReason: r.session?.endReason ?? r.endReason }));
  }
  async history(userId: string) {
    return this.transaction(async tx => { await this.user(tx, userId); return this.historyIn(tx, userId); });
  }
  async adminData(userId: string) {
    return this.transaction(async tx => {
      await this.user(tx, userId, 'ADMIN');
      const requests = await tx.questionRequest.findMany({ select: { status: true, subjectId: true, createdAt: true, matchedAt: true } });
      const feedbacks = await tx.feedback.findMany({ select: { resolution: true } });
      const matched = requests.filter(r => r.matchedAt !== null);
      const subjects = await tx.subject.findMany({ orderBy: { id: 'asc' } });
      const stats = {
        requestCount: requests.length, matchedCount: matched.length,
        completedCount: requests.filter(r => r.status === 'COMPLETED').length,
        expiredCount: requests.filter(r => r.status === 'EXPIRED').length,
        cancelledCount: requests.filter(r => r.status === 'CANCELLED').length,
        averageMatchMs: matched.length ? matched.reduce((sum, r) => sum + r.matchedAt!.getTime() - r.createdAt.getTime(), 0) / matched.length : null,
        solvedRatio: feedbacks.length ? feedbacks.filter(f => f.resolution === 'SOLVED').length / feedbacks.length : null,
        feedbackCount: feedbacks.length,
        bySubject: subjects.map(s => ({ ...s, count: requests.filter(r => r.subjectId === s.id).length })),
      };
      const users = await tx.user.findMany({ include: { profile: { include: { subjects: { include: { subject: true } } } } }, orderBy: { id: 'asc' } });
      return { stats, subjects, users: users.map(u => ({ ...publicUser(u), enabled: u.profile?.enabled ?? true, bio: u.profile?.bio ?? '', subjects: u.profile?.subjects.map(s => s.subject) ?? [] })) };
    });
  }
  async updateAnswerer(userId: string, answererId: string, input: { enabled: boolean; subjectIds: string[] }) {
    if (typeof input.enabled !== 'boolean' || !Array.isArray(input.subjectIds) || input.subjectIds.some(s => typeof s !== 'string')) fail('答疑者设置格式不正确');
    const subjectIds = [...new Set(input.subjectIds)];
    return this.transaction(async (tx, now) => {
      await this.user(tx, userId, 'ADMIN');
      const profile = await tx.answererProfile.findUnique({ where: { userId: answererId } });
      if (!profile) fail('答疑者不存在', 404, 'NOT_FOUND');
      if (await tx.subject.count({ where: { id: { in: subjectIds } } }) !== subjectIds.length) fail('所选科目不存在');
      await tx.answererProfile.update({ where: { userId: answererId }, data: { enabled: input.enabled, ...(!input.enabled ? { online: false, heartbeatAt: null } : {}) } });
      await tx.answererSubject.deleteMany({ where: { answererId } });
      for (const subjectId of subjectIds) await tx.answererSubject.create({ data: { answererId, subjectId } });
      const offers = await tx.invitation.findMany({ where: { answererId, status: 'PENDING' }, include: { request: true } });
      for (const offer of offers) if (!input.enabled || !subjectIds.includes(offer.request.subjectId)) await this.decideRejection(tx, offer, now, answererId, 'PROFILE_CHANGED');
      await this.event(tx, 'ANSWERER_CONFIG_CHANGED', now, { actorId: userId, detail: answererId });
      await this.schedule(tx, now);
      return { ok: true };
    });
  }
}

export function createDomain(client: PrismaClient, options: DomainOptions = {}) { return new Domain(client, options); }
export const domain = createDomain(db);
