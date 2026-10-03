"use client";

import Link from "next/link";
import { use, useState, type FormEvent } from "react";
import { AuthGate, Empty, ErrorNotice, Loading, PageHeading } from "@/components/site-shell";
import { messageOf, post, resolutionLabels, usePolling, type Feedback, type Room } from "@/lib/client";

export default function FeedbackPage({ params }: { params: Promise<{ sessionId: string }> }) { const { sessionId } = use(params); return <AuthGate role="ASKER"><FeedbackForm sessionId={sessionId} /></AuthGate>; }
function FeedbackForm({ sessionId }: { sessionId: string }) {
  const poll = usePolling<{ session: Room }>(`/sessions/${sessionId}`, 2000);
  const [resolution, setResolution] = useState<"SOLVED" | "PARTIAL" | "UNSOLVED" | "">("");
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState<Feedback | null>(null);
  const room = poll.data?.session;
  async function submit(event: FormEvent) { event.preventDefault(); if (!resolution || !rating) { setError("请选择问题解决情况与 1—5 分满意度。"); return; } setBusy(true); setError(""); try { const result = await post<{ feedback: Feedback }>(`/sessions/${sessionId}/feedback`, { resolution, rating, comment: comment.trim() }); setSubmitted(result.feedback); await poll.refresh(); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); } }
  if (poll.loading && !room) return <Loading />;
  if (!room) return <ErrorNotice error={poll.error || "无法读取这场答疑。"} retry={() => void poll.refresh()} />;
  if (!room.endedAt) return <Empty title="答疑尚未结束" text="请先结束本次答疑，再填写体验反馈。" action={<Link className="button primary" href={`/student/room/${sessionId}`}>返回答疑室</Link>} />;
  if (room.endReason === "ABANDONED") return <Empty title="本次答疑因失联已回收" text="这次答疑未正常完成，不开放反馈。你可以重新发起问题。" action={<Link className="button primary" href="/student/ask">重新提问</Link>} />;
  const saved = submitted || room.feedback;
  return <div className="narrow"><PageHeading eyebrow="让下一次交流更好" title="这次问题解决了吗？" description={`${room.request.subject.name} · 与 ${room.answerer.name} 的答疑反馈`} /><ErrorNotice error={poll.error} retry={() => void poll.refresh()} />{saved ? <div className="card match-card"><div className="match-orb" aria-hidden>✓</div><h2>反馈已保存，谢谢你</h2><p>{resolutionLabels[saved.resolution]} · 满意度 {saved.rating}/5 分</p>{saved.comment && <div className="question-summary"><p>{saved.comment}</p></div>}<div className="button-row" style={{ justifyContent: "center", marginTop: 25 }}><Link className="button primary" href="/student/history">查看答疑记录</Link><Link className="button secondary" href="/student/ask">发起新的问题</Link></div></div> : <form className="card feedback-card" onSubmit={submit}><fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}><div className="field"><span className="field-label">问题解决情况<span className="required">*</span></span><div className="resolution-options" role="group" aria-label="问题解决情况">{Object.entries(resolutionLabels).map(([value, label]) => <button key={value} type="button" className={`resolution-button ${resolution === value ? "selected" : ""}`} aria-pressed={resolution === value} onClick={() => setResolution(value as "SOLVED" | "PARTIAL" | "UNSOLVED")}>{label}</button>)}</div></div><div className="field"><span className="field-label">满意度<span className="required">*</span></span><div className="rating-options" role="group" aria-label="满意度">{[1, 2, 3, 4, 5].map(value => <button key={value} type="button" className={`rating-button ${value <= rating ? "selected" : ""}`} aria-label={`满意度${value}分`} aria-pressed={value === rating} onClick={() => setRating(value)}>{value}</button>)}</div><p className="rating-help">1 分：不满意 · 5 分：很满意{rating > 0 && ` · 已选择 ${rating} 分`}</p></div><div className="field"><label htmlFor="feedback-comment">想补充的意见 <span className="caption">可选</span></label><textarea id="feedback-comment" value={comment} onChange={e => setComment(e.target.value)} maxLength={500} rows={4} placeholder="哪些讲解帮到了你？还有哪些地方可以更清楚？" /><p className="field-help" style={{ textAlign: "right" }}>{comment.length}/500</p></div><ErrorNotice error={error} /><button className="button primary full" type="submit" disabled={busy}>{busy ? "正在提交…" : "提交反馈"}</button><p className="field-help" style={{ textAlign: "center", marginTop: 12 }}>每场答疑保存一条反馈，重复提交不会生成重复记录。</p></fieldset></form>}</div>;
}
