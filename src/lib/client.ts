"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Role = "ASKER" | "ANSWERER" | "ADMIN";
export interface User { id: string; name: string; role: Role }
export interface Subject { id: string; name: string }
export interface Answerer { id: string; name: string; bio: string; subjects: Subject[]; status: "AVAILABLE" | "BUSY" | "OFFLINE"; enabled: boolean; online?: boolean }
export interface Catalog { subjects: Subject[]; answerers: Answerer[]; onlineCount: number; config: { waitMs: number; offerMs: number; heartbeatMs: number; pollMs: number } }
export interface RequestView { id: string; askerId: string; subjectId: string; subject: Subject; description: string; mode: "DIRECT" | "QUICK"; status: string; createdAt: string; deadlineAt: string; matchedAt?: string | null; sessionId?: string | null; targetAnswererId?: string | null; attachmentId?: string | null; offers?: Offer[] }
export interface Offer { id: string; deadlineAt: string; status: string; request: RequestView }
export interface Message { id: string; senderId: string; body: string; createdAt: string; clientId: string }
export interface Feedback { id: string; resolution: "SOLVED" | "PARTIAL" | "UNSOLVED"; rating: number; comment: string; createdAt: string }
export interface Room { id: string; requestId: string; askerId: string; answererId: string; asker: User; answerer: User; request: RequestView; startedAt: string | null; endedAt: string | null; endReason: string | null; messages: Message[]; feedback: Feedback | null }
export interface HistoryItem { id: string; requestId: string; subject: Subject; otherName: string; status: string; createdAt: string; startedAt: string | null; endedAt: string | null; sessionId: string | null; feedback: Feedback | null; description: string; endReason?: string | null }
export interface Dashboard { profile: Answerer; subjects: Subject[]; offers: Offer[]; currentSession: Room | null; history: HistoryItem[] }
export interface Stats { requestCount: number; matchedCount: number; completedCount: number; expiredCount: number; cancelledCount: number; averageMatchMs: number | null; solvedRatio: number | null; feedbackCount: number; bySubject: { id: string; name: string; count: number }[] }
export interface AdminUser extends User { enabled: boolean; subjects: Subject[]; bio?: string }
export interface AdminData { stats: Stats; users: AdminUser[]; subjects: Subject[] }

export class ApiError extends Error { constructor(message: string, public status: number, public code?: string, public requestId?: string) { super(message); } }

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...options, cache: "no-store", credentials: "same-origin", headers: { ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }), ...options.headers } }); }
  catch { throw new ApiError("网络连接中断，请检查网络后重试。", 0); }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.error || "操作未成功，请稍后重试。", response.status, data?.code, data?.requestId);
  return data as T;
}
export function post<T>(path: string, body: unknown = {}) { return api<T>(path, { method: "POST", body: JSON.stringify(body) }); }
export function messageOf(error: unknown) { return error instanceof Error ? error.message : "操作未成功，请重试。"; }
export function newKey() { return crypto.randomUUID(); }
export function displayDate(value: string | null) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "尚未开始"; }
export function duration(ms: number) { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
export const statusLabels: Record<string, string> = { WAITING: "等待在线答疑者", OFFERED: "已向答疑者发出邀请", MATCHED: "答疑者已接受", IN_PROGRESS: "答疑进行中", COMPLETED: "答疑已结束", CANCELLED: "请求已取消", EXPIRED: "等待超时", DECLINED: "指定答疑者拒绝了请求" };
export const resolutionLabels = { SOLVED: "已解决", PARTIAL: "部分解决", UNSOLVED: "未解决" };

export function usePolling<T>(path: string | null, interval = 2000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const alive = useRef(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!path || busy.current) return;
    const attempt = generation.current;
    busy.current = true;
    controller.current = new AbortController();
    try { const next = await api<T>(path, { signal: controller.current.signal }); if (alive.current && attempt === generation.current) { setData(next); setError(""); } }
    catch (e) { if (alive.current && attempt === generation.current) setError(messageOf(e)); }
    finally { if (attempt === generation.current) { busy.current = false; if (alive.current) setLoading(false); } }
  }, [path]);
  useEffect(() => { generation.current += 1; busy.current = false; alive.current = true; setLoading(Boolean(path)); setData(null); setError(""); void refresh(); const timer = interval > 0 ? setInterval(() => void refresh(), interval) : null; return () => { alive.current = false; generation.current += 1; busy.current = false; controller.current?.abort(); if (timer) clearInterval(timer); }; }, [refresh, interval, path]);
  return { data, error, loading, refresh };
}
export function useNow(interval = 1000) { const [now, setNow] = useState(() => Date.now()); useEffect(() => { const timer = setInterval(() => setNow(Date.now()), interval); return () => clearInterval(timer); }, [interval]); return now; }
