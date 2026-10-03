"use client";

import { useState } from "react";
import { MonitoringPanel } from "@/components/admin-monitoring";
import { AuthGate, ErrorNotice, Loading, PageHeading } from "@/components/site-shell";
import { messageOf, post, usePolling, type AdminData, type AdminUser, type Subject } from "@/lib/client";

export default function AdminPage() { return <AuthGate role="ADMIN"><Admin /></AuthGate>; }
function Admin() {
  const poll = usePolling<AdminData>("/admin");
  if (poll.loading && !poll.data) return <Loading text="正在读取平台统计…" />;
  if (!poll.data) return <ErrorNotice error={poll.error || "无法读取管理数据。"} retry={() => void poll.refresh()} />;
  const { stats, subjects } = poll.data;
  const users = poll.data.users.map(original => {
    const user = original as ManagedUser;
    return { ...user, university: user.studentProfile?.university ?? user.teacherProfile?.university ?? user.university, major: user.studentProfile?.major ?? user.teacherProfile?.major ?? user.major, degree: user.teacherProfile?.degree ?? user.degree };
  });
  const metrics = [{ name: "答疑请求", value: stats.requestCount, caption: "数据库中的全部答疑请求" }, { name: "成功匹配", value: stats.matchedCount, caption: "教师实际接受的请求" }, { name: "已完成答疑", value: stats.completedCount, caption: "已结束的答疑会话" }, { name: "问题解决比例", value: stats.solvedRatio === null ? "—" : `${Math.round(stats.solvedRatio * 100)}%`, caption: `${stats.feedbackCount} 条反馈中的已解决比例` }];
  return <><PageHeading eyebrow="管理员" title="管理控制台" description="汇总数据库中的匹配、答疑与反馈记录。" action={<a className="button secondary" href="/api/admin/export?portal=admin" download>导出汇总 CSV ↓</a>} /><ErrorNotice error={poll.error} retry={() => void poll.refresh()} /><div className="stats-grid">{metrics.map(metric => <div className="card stat-card" key={metric.name}><p>{metric.name}</p><div className="stat-value">{metric.value}</div><small>{metric.caption}</small></div>)}</div><div className="admin-layout"><section className="card"><div className="card-header"><h2>各科目请求</h2><small>全部请求</small></div>{stats.bySubject.length ? stats.bySubject.map(subject => <div className="bar-row" key={subject.id}><span className="bar-label">{subject.name}</span><div className="bar-track"><div className="bar-fill" style={{ width: `${stats.requestCount ? subject.count / stats.requestCount * 100 : 0}%` }} /></div><span className="bar-count">{subject.count}</span></div>) : <p className="caption">尚无请求记录</p>}</section><section className="card"><h2>匹配与等待</h2><div className="admin-metric"><span>平均匹配耗时</span><strong>{stats.averageMatchMs === null ? "暂无数据" : `${(stats.averageMatchMs / 1000).toFixed(1)} 秒`}</strong></div><div className="admin-metric"><span>等待超时</span><strong>{stats.expiredCount}</strong></div><div className="admin-metric"><span>主动取消</span><strong>{stats.cancelledCount}</strong></div><div className="admin-metric"><span>收到反馈</span><strong>{stats.feedbackCount}</strong></div></section></div><div className="section-title"><div><h2>教师与接单权限</h2><p>审核教师本人填写的资料，管理可答科目和接单资格。</p></div><span className="section-count">{users.filter(user => user.role === "ANSWERER").length} 个教师账户</span></div><div className="card table-card"><table className="account-table"><thead><tr><th scope="col">教师资料</th><th scope="col">资料来源</th><th scope="col">接单权限</th><th scope="col">可答科目</th><th scope="col">操作</th></tr></thead><tbody>{users.filter(user => user.role === "ANSWERER").map(user => <AccountRow key={`${user.id}:${user.enabled}:${user.subjects.map(subject => subject.id).join(",")}`} user={user} subjects={subjects} refresh={poll.refresh} />)}</tbody></table>{!users.some(user => user.role === "ANSWERER") && <p className="caption" style={{ padding: 20 }}>暂时没有教师账户。</p>}</div><div className="section-title"><div><h2>学生账户</h2><p>学生资料与教师接单权限分开管理。</p></div><span className="section-count">{users.filter(user => user.role === "ASKER").length} 个学生账户</span></div><div className="card table-card"><table className="account-table"><thead><tr><th scope="col">显示名称</th><th scope="col">登录账号</th><th scope="col">学校</th><th scope="col">专业</th></tr></thead><tbody>{users.filter(user => user.role === "ASKER").map(user => <tr key={user.id}><td><strong>{user.name}</strong></td><td>{(user as ManagedUser).account || (user as ManagedUser).username || "—"}</td><td>{(user as ManagedUser).university || "未填写"}</td><td>{(user as ManagedUser).major || "未填写"}</td></tr>)}</tbody></table>{!users.some(user => user.role === "ASKER") && <p className="caption" style={{ padding: 20 }}>暂时没有学生账户。</p>}</div><MonitoringPanel /><div className="notice">CSV 仅包含汇总统计，不包含私人聊天、图片或身份材料。</div></>;
}
interface ManagedUser extends AdminUser {
  account?: string; username?: string; university?: string | null; major?: string | null;
  degree?: string | null; profileSource?: string;
  studentProfile?: { university?: string | null; major?: string | null } | null;
  teacherProfile?: { university?: string | null; major?: string | null; degree?: string | null } | null;
}
function AccountRow({ user, subjects, refresh }: { user: ManagedUser; subjects: Subject[]; refresh: () => Promise<void> }) {
  const [enabled, setEnabled] = useState(user.enabled);
  const [selected, setSelected] = useState(user.subjects.map(subject => subject.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const answerer = user.role === "ANSWERER";
  async function save() { setBusy(true); setError(""); setSaved(false); try { await post(`/admin/answerers/${user.id}`, { enabled, subjectIds: selected }); setSaved(true); await refresh(); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); } }
  return <tr><td><strong>{user.name}</strong><div className="caption">{user.account || user.username || "—"}</div><div className="caption">{user.university || "学校未填写"} · {({ UNDERGRADUATE: "本科生", MASTER: "硕士研究生", DOCTORATE: "博士研究生" } as Record<string, string>)[user.degree || ""] || "学历未填写"}</div>{user.bio && <p className="caption">{user.bio}</p>}</td><td>{user.profileSource === "SELF_DECLARED" ? "本人填写" : "历史账户资料"}</td><td>{answerer ? <label className="admin-toggle"><input type="checkbox" aria-label={`启用${user.name}`} checked={enabled} disabled={busy} onChange={e => { setEnabled(e.target.checked); setSaved(false); }} />{enabled ? "允许接单" : "待审核 / 已停用"}</label> : <span className="caption">—</span>}</td><td>{answerer ? <div className="checkbox-subjects">{subjects.map(subject => <label key={subject.id}><input type="checkbox" checked={selected.includes(subject.id)} disabled={busy} onChange={e => { setSelected(current => e.target.checked ? [...current, subject.id] : current.filter(id => id !== subject.id)); setSaved(false); }} />{subject.name}</label>)}</div> : <span className="caption">—</span>}</td><td>{answerer ? <><button className="button secondary small" onClick={() => void save()} disabled={busy} aria-label={`保存${user.name}设置`}>{busy ? "保存中…" : "保存设置"}</button>{error && <div className="caption" role="alert" style={{ color: "var(--red)", maxWidth: 130 }}>{error}</div>}{saved && <div className="status-note" role="status">已保存</div>}</> : <span className="caption">—</span>}</td></tr>;
}
