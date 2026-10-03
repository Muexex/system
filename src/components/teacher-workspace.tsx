"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { HistoryList } from "@/components/history-list";
import { AuthGate, Empty, ErrorNotice, Loading, PageHeading, StatusPill } from "@/components/site-shell";
import { messageOf, post, useNow, usePolling, type Dashboard } from "@/lib/client";

export default function AnswerPage() { return <AuthGate role="ANSWERER"><Workspace /></AuthGate>; }
function Workspace() {
  const poll = usePolling<Dashboard>("/answer");
  const router = useRouter();
  const now = useNow();
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const profile = poll.data?.profile;
  const online = profile?.online ?? (profile?.status !== "OFFLINE");
  async function setPresence() { setPending("presence"); setError(""); try { await post("/presence", { online: !online }); await poll.refresh(); } catch (e) { setError(messageOf(e)); } finally { setPending(""); } }
  async function accept(id: string) { setPending(id); setError(""); try { const result = await post<{ sessionId: string }>(`/offers/${id}/accept`); router.push(`/teacher/room/${result.sessionId}`); } catch (e) { setError(messageOf(e)); await poll.refresh(); } finally { setPending(""); } }
  async function reject(id: string) { setPending(id); setError(""); try { await post(`/offers/${id}/reject`); await poll.refresh(); } catch (e) { setError(messageOf(e)); } finally { setPending(""); } }
  if (poll.loading && !profile) return <Loading text="正在读取答疑工作台…" />;
  if (!profile || !poll.data) return <ErrorNotice error={poll.error || "工作台暂时不可用。"} retry={() => void poll.refresh()} />;
  const offers = poll.data.offers.filter(offer => offer.status === "OFFERED" || offer.status === "PENDING");
  return <><PageHeading eyebrow="教师工作台" title="准备好一起解题了吗？" description="主动上线后接收请求，一次专注于一个问题。" action={<Link className="button secondary" href="/teacher/profile">管理个人资料</Link>} /><ErrorNotice error={error || poll.error} retry={poll.error ? () => void poll.refresh() : undefined} />{!profile.enabled && <div className="notice"><strong>接单权限待审核</strong><p>请先完善学校、学历层次、擅长方向和可答科目。管理员启用权限后才能上线接收邀请。</p><Link href="/teacher/profile" className="text-button">完善个人资料 ↗</Link></div>}<div className="workspace-top"><div className="card presence-card"><div className="avatar">{profile.name.slice(-1)}</div><div className="presence-info"><h2>{profile.name}</h2><p>教师资料 · 本人填写</p><span className="caption">{!profile.enabled ? "尚未获得接单权限，请完善资料并等待管理员审核。" : online ? "保持此浏览器会话打开以接收邀请。" : "当前离线，主动上线后才会被匹配。"}</span></div><div className="presence-controls"><StatusPill status={profile.status} /><br /><button className={`button ${online ? "secondary" : "primary"}`} onClick={() => void setPresence()} disabled={Boolean(pending) || !profile.enabled}>{pending === "presence" ? "更新中…" : online ? "暂停接单" : "开始接单"}</button></div></div><div className="card profile-subjects"><h3>我的可答科目</h3><div className="tags">{profile.subjects.map(subject => <span key={subject.id} className="tag">{subject.name}</span>)}</div>{!profile.subjects.length && <p className="caption">请在资料页选择可答科目。</p>}<small>审核通过后可上线接单。</small></div></div>{poll.data.currentSession && <div className="card active-session"><div><h3>你有一场尚未结束的答疑</h3><p>{poll.data.currentSession.request.subject.name} · 与 {poll.data.currentSession.asker.name}</p></div><Link className="button primary" href={`/teacher/room/${poll.data.currentSession.id}`}>继续当前答疑 ↗</Link></div>}<div className="section-title"><h2>待处理请求</h2><span className="section-count">{offers.length} 条邀请</span></div>{offers.length ? <div className="offers-grid">{offers.map(offer => <article className="card offer-card" key={offer.id}><div className="offer-top"><span className="tag">{offer.request.subject.name}</span><span className="offer-countdown">接单剩余 {Math.max(0, Math.ceil((Date.parse(offer.deadlineAt) - now) / 1000))} 秒</span></div><p>{offer.request.description}</p>{offer.request.attachmentId && <Link className="text-button" style={{ marginLeft: 0, display: "inline-block", marginBottom: 12 }} target="_blank" href={`/api/attachments/${offer.request.attachmentId}?portal=teacher`}>查看题目图片 ↗</Link>}<div className="button-row"><button className="button primary" onClick={() => void accept(offer.id)} disabled={Boolean(pending)}>{pending === offer.id ? "处理中…" : "接受请求"}</button><button className="button secondary" onClick={() => void reject(offer.id)} disabled={Boolean(pending)}>拒绝请求</button></div></article>)}</div> : <Empty title={!profile.enabled ? "审核通过后即可接收问题" : poll.data.currentSession ? "专注于当前答疑" : online ? "正在等待新的问题" : "上线后接收邀请"} text={!profile.enabled ? "当前无法上线接单，你可以先完善资料。" : poll.data.currentSession ? "结束当前答疑后才能接收下一个问题。" : online ? "符合你可答科目的新请求会自动出现在这里。" : "点击“开始接单”，让学生看到你的在线状态。"} />}<div className="section-title"><h2>最近的答疑</h2><Link className="caption" href="/teacher/history">查看全部 ↗</Link></div><HistoryList items={poll.data.history.slice(0, 3)} portal="teacher" /></>;
}
