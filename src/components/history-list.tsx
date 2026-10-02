"use client";

import Link from "next/link";
import { Empty, useAuth } from "@/components/site-shell";
import { displayDate, duration, resolutionLabels, statusLabels, useNow, type HistoryItem } from "@/lib/client";

export function HistoryList({ items }: { items: HistoryItem[] }) {
  const { user } = useAuth();
  const now = useNow();
  if (!items.length) return <Empty title="还没有答疑记录" text="完成一次真实答疑后，科目、交流时间与反馈会出现在这里。" action={user?.role === "ASKER" ? <Link className="button primary" href="/ask">发起第一个问题</Link> : undefined} />;
  return <div className="history-list">{items.map(item => <article className="card history-card" key={item.id}><div className="history-top"><h3>{item.subject.name}<span className="caption" style={{ fontWeight: 400, marginLeft: 10 }}>与 {item.otherName || "等待匹配的伙伴"}</span></h3><span className={`state-tag ${item.status.toLowerCase()}`}>{statusLabels[item.status] || item.status}</span></div><div className="history-meta"><span>发起 {displayDate(item.createdAt)}</span>{item.startedAt && <span>开始 {displayDate(item.startedAt)}</span>}{item.endedAt && <span>结束 {displayDate(item.endedAt)}</span>}<span>答疑时长 {item.startedAt ? duration((item.endedAt ? Date.parse(item.endedAt) : now) - Date.parse(item.startedAt)) : "尚未开始"}</span></div><p className="history-description">{item.description}</p><div className="history-bottom"><span className="history-feedback">{item.feedback ? `${resolutionLabels[item.feedback.resolution]} · 满意度 ${item.feedback.rating}/5${item.feedback.comment ? ` · ${item.feedback.comment}` : ""}` : "尚无反馈"}</span><div className="button-row">{item.sessionId ? <><Link className="button secondary small" href={`/room/${item.sessionId}`}>{item.endedAt ? "查看交流记录" : "进入答疑室"}</Link>{user?.role === "ASKER" && item.endedAt && item.endReason !== "ABANDONED" && !item.feedback && <Link className="button primary small" href={`/feedback/${item.sessionId}`}>填写反馈</Link>}</> : user?.role === "ASKER" ? <Link href={`/match/${item.requestId}`} className="button secondary small">查看请求</Link> : null}</div></div></article>)}</div>;
}
