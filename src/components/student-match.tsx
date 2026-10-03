"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useState } from "react";
import { AuthGate, ErrorNotice, Loading, PageHeading } from "@/components/site-shell";
import { duration, messageOf, post, statusLabels, useNow, usePolling, type RequestView } from "@/lib/client";

export default function MatchPage({ params }: { params: Promise<{ requestId: string }> }) { const { requestId } = use(params); return <AuthGate role="ASKER"><Match requestId={requestId} /></AuthGate>; }
function Match({ requestId }: { requestId: string }) {
  const poll = usePolling<{ request: RequestView }>(`/requests/${requestId}`);
  const request = poll.data?.request;
  const router = useRouter();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (request?.sessionId && ["MATCHED", "IN_PROGRESS"].includes(request.status)) router.replace(`/student/room/${request.sessionId}`); }, [request?.sessionId, request?.status, router]);
  async function cancel() { setBusy(true); setError(""); try { await post(`/requests/${requestId}/cancel`); await poll.refresh(); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); } }
  if (poll.loading && !request) return <Loading text="正在读取匹配状态…" />;
  if (!request) return <ErrorNotice error={poll.error || "无法读取这条答疑请求。"} retry={() => void poll.refresh()} />;
  const waiting = ["WAITING", "OFFERED"].includes(request.status);
  const explanatory: Record<string, string> = { WAITING: "正在等待该科目可接单的在线伙伴。你可以随时取消。", OFFERED: "邀请已发出，正在等待答疑伙伴确认。", MATCHED: "正在进入属于你们的临时答疑室。", IN_PROGRESS: "答疑已开始，正在为你恢复答疑室。", CANCELLED: "本次请求已经取消。需要时可以重新发起问题。", EXPIRED: "等待时间已到，未能匹配成功。可以重新发起一次请求。", DECLINED: "对方拒绝了本次邀请。你可以重新选择其他教师。", COMPLETED: "本次答疑已经结束，可查看交流记录与反馈。" };
  return <div className="narrow"><PageHeading eyebrow="正在寻找答疑伙伴" title="匹配进度" description="匹配状态实时更新，以伙伴的真实接受结果为准。" /><ErrorNotice error={poll.error || error} retry={poll.error ? () => void poll.refresh() : undefined} /><div className="card match-card"><div className={`match-orb ${waiting ? "waiting" : ""}`} aria-hidden>{waiting ? "◷" : request.status === "COMPLETED" ? "✓" : "○"}</div><h2>{statusLabels[request.status] || request.status}</h2><p>{explanatory[request.status]}</p>{waiting && <div className="match-timing"><div>已经等待<strong>{duration(now - Date.parse(request.createdAt))}</strong></div><div>总等待剩余<strong>{Math.max(0, Math.ceil((Date.parse(request.deadlineAt) - now) / 1000))} 秒</strong></div></div>}<div className="question-summary"><span className="tag">{request.subject.name}</span><span className="caption">{request.mode === "DIRECT" ? "指定教师" : "快速匹配"}</span><p>{request.description}</p>{request.attachmentId && <Link href={`/api/attachments/${request.attachmentId}?portal=student`} target="_blank" className="text-button" style={{ marginLeft: 0 }}>查看题目图片 ↗</Link>}</div>{waiting ? <button className="button secondary" onClick={() => void cancel()} disabled={busy}>{busy ? "正在取消…" : "取消请求"}</button> : <div className="button-row" style={{ justifyContent: "center" }}>{request.sessionId && <Link href={`/student/room/${request.sessionId}`} className="button primary">查看答疑室</Link>}<Link href="/student/ask" className="button secondary">重新提问</Link><Link href="/student/history" className="button secondary">查看记录</Link></div>}</div></div>;
}
