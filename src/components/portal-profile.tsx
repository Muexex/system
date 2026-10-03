"use client";

import { useEffect, useState, type FormEvent } from "react";
import { AuthGate, ErrorNotice, Loading, PageHeading, useAuth } from "@/components/site-shell";
import { messageOf, post, usePolling, type Subject } from "@/lib/client";

type Portal = "student" | "teacher";
interface Profile {
  userId: string; username: string; account: string; displayName: string;
  university: string | null; major: string | null; degree: string | null;
  bio: string; subjectIds: string[]; enabled: boolean;
  approvalStatus: "APPROVED" | "PENDING"; profileSource?: string;
}
interface ProfileData { profile: Profile; subjects: Subject[] }

export default function PortalProfile({ portal }: { portal: Portal }) {
  return <AuthGate role={portal === "student" ? "ASKER" : "ANSWERER"}><ProfileForms portal={portal} /></AuthGate>;
}

function ProfileForms({ portal }: { portal: Portal }) {
  const poll = usePolling<ProfileData>(`/${portal}/profile`, 0);
  const { refresh: refreshAuth } = useAuth();
  const [form, setForm] = useState({ displayName: "", university: "", major: "", degree: "", bio: "", subjectIds: [] as string[] });
  const [initialized, setInitialized] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const profile = poll.data?.profile;
  useEffect(() => {
    if (!profile || initialized === profile.userId) return;
    setForm({ displayName: profile.displayName, university: profile.university || "", major: profile.major || "", degree: profile.degree || "", bio: profile.bio || "", subjectIds: profile.subjectIds || [] });
    setInitialized(profile.userId);
  }, [profile, initialized]);

  function change(key: "displayName" | "university" | "major" | "degree" | "bio", value: string) {
    setSaved(false); setForm(previous => ({ ...previous, [key]: value }));
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return; if (portal === "teacher" && !form.subjectIds.length) { setError("请至少选择一个可答科目。"); return; } setBusy(true); setError(""); setSaved(false);
    try {
      const fields = portal === "student" ? { displayName: form.displayName.trim(), university: form.university.trim(), major: form.major.trim() } : { displayName: form.displayName.trim(), university: form.university.trim(), degree: form.degree, bio: form.bio.trim(), subjectIds: form.subjectIds };
      await post(`/${portal}/profile`, fields); await poll.refresh(); await refreshAuth(); setSaved(true);
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }
  async function savePassword(event: FormEvent) {
    event.preventDefault(); if (passwordBusy) return;
    if (newPassword !== confirmation) { setPasswordError("两次输入的新口令不一致。"); return; }
    setPasswordBusy(true); setPasswordError(""); setPasswordSaved(false);
    try {
      await post(`/${portal}/profile/password`, { currentPassword, newPassword });
      setCurrentPassword(""); setNewPassword(""); setConfirmation(""); setPasswordSaved(true); await refreshAuth();
    } catch (cause) { setPasswordError(messageOf(cause)); } finally { setPasswordBusy(false); }
  }
  if (poll.loading && !profile) return <Loading text="正在读取个人资料…" />;
  if (!profile) return <ErrorNotice error={poll.error || "无法读取个人资料。"} retry={() => void poll.refresh()} />;

  return <><PageHeading eyebrow={portal === "student" ? "学生中心" : "教师中心"} title="个人资料" description="管理你的公开称呼、学习资料与登录口令。" /><ErrorNotice error={poll.error} retry={() => void poll.refresh()} />{portal === "teacher" && <div className={`notice ${profile.enabled ? "" : "warning"}`}><strong>{profile.enabled ? "可接单权限已启用" : "接单权限待审核"}</strong><p>{profile.enabled ? "你可以前往工作台主动上线。" : "请填写学校、学历层次、擅长方向与可答科目。管理员启用接单权限后，你才能上线。"} 个人资料由本人填写。</p></div>}<div className="form-layout"><form className="card form-card" onSubmit={save}><fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}><h2>基本资料</h2><div className="field"><label htmlFor="profile-account">登录账号</label><input id="profile-account" value={profile.account || profile.username} readOnly aria-readonly="true" /><p className="field-help">登录账号用于识别账户，不能在资料页修改。</p></div><div className="field"><label htmlFor="profile-name">显示名称<span className="required">*</span></label><input id="profile-name" value={form.displayName} onChange={event => change("displayName", event.target.value)} minLength={2} maxLength={30} required autoComplete="nickname" /></div><div className="field"><label htmlFor="profile-university">就读学校</label><input id="profile-university" value={form.university} onChange={event => change("university", event.target.value)} minLength={2} maxLength={100} required={portal === "teacher"} autoComplete="organization" /></div>{portal === "student" ? <div className="field"><label htmlFor="profile-major">专业</label><input id="profile-major" value={form.major} onChange={event => change("major", event.target.value)} minLength={2} maxLength={100} /></div> : <><div className="field"><label htmlFor="profile-degree">学历层次</label><select id="profile-degree" required value={form.degree} onChange={event => change("degree", event.target.value)}><option value="">请选择</option><option value="UNDERGRADUATE">本科生</option><option value="MASTER">硕士研究生</option><option value="DOCTORATE">博士研究生</option></select></div><div className="field"><label htmlFor="profile-bio">擅长方向与个人介绍</label><textarea id="profile-bio" value={form.bio} onChange={event => change("bio", event.target.value)} minLength={20} maxLength={500} required rows={4} placeholder="例如：擅长高等数学的极限、积分与证明思路。" /><p className="field-help">填写你的真实擅长方向，最多 500 字。</p></div><fieldset className="field" style={{ border: 0, margin: 0, padding: 0 }}><legend className="field-label">可答科目</legend><div className="checkbox-subjects">{poll.data?.subjects.map(subject => <label key={subject.id}><input type="checkbox" checked={form.subjectIds.includes(subject.id)} onChange={event => { setSaved(false); setForm(previous => ({ ...previous, subjectIds: event.target.checked ? [...previous.subjectIds, subject.id] : previous.subjectIds.filter(id => id !== subject.id) })); }} />{subject.name}</label>)}</div></fieldset><p className="field-help">教师限成年、非在职的全日制在校大学生或研究生。这里不上传身份证或学籍材料。</p></>}<ErrorNotice error={error} />{saved && <p className="status-note" role="status">{portal === "teacher" ? "资料已保存，接单状态以上方显示为准。关键信息变更后需要重新审核。" : "资料已保存"}</p>}<button className="button primary full" type="submit" disabled={busy}>{busy ? "正在保存…" : "保存资料"}</button></fieldset></form><form className="card form-card" onSubmit={savePassword}><fieldset disabled={passwordBusy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><h2>修改登录口令</h2><p className="field-help">修改口令需要验证当前口令。</p><div className="field"><label htmlFor="current-password">当前口令</label><input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required maxLength={256} /></div><div className="field"><label htmlFor="new-password">新口令</label><input id="new-password" type="password" autoComplete="new-password" value={newPassword} onChange={event => setNewPassword(event.target.value)} required minLength={10} maxLength={256} /></div><div className="field"><label htmlFor="confirm-password">确认新口令</label><input id="confirm-password" type="password" autoComplete="new-password" value={confirmation} onChange={event => setConfirmation(event.target.value)} required minLength={10} maxLength={256} /></div><ErrorNotice error={passwordError} />{passwordSaved && <p className="status-note" role="status">登录口令已更新</p>}<button className="button secondary full" disabled={passwordBusy} type="submit">{passwordBusy ? "正在更新…" : "更新口令"}</button></fieldset></form></div></>;
}
