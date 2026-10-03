"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ErrorNotice, useAuth } from "@/components/site-shell";
import { messageOf, portalPath, post, usePolling, type Catalog, type Portal, type User } from "@/lib/client";

type AuthMode = "login" | "register";
const portalLabels = { student: "学生", teacher: "教师", admin: "管理员" };
function PasswordField({ id, label, value, onChange, confirmation = false, login = false, disabled = false }: { id: string; label: string; value: string; onChange: (value: string) => void; confirmation?: boolean; login?: boolean; disabled?: boolean }) {
  const [visible, setVisible] = useState(false);
  return <div className="auth-field"><label htmlFor={id}>{label}</label><div className="password-control"><input id={id} type={visible ? "text" : "password"} value={value} onChange={event => onChange(event.target.value)} autoComplete={login ? "current-password" : "new-password"} placeholder={confirmation ? "再次输入密码" : login ? "请输入密码" : "设置 10—128 位密码"} maxLength={256} required disabled={disabled} /><button type="button" disabled={disabled} className="password-toggle" aria-label={visible ? `隐藏${label}` : `显示${label}`} aria-pressed={visible} onClick={() => setVisible(current => !current)}>{visible ? "隐藏" : "显示"}</button></div></div>;
}

export function AuthForm({ portal, mode }: { portal: Portal; mode: AuthMode }) {
  const register = mode === "register";
  const teacher = portal === "teacher";
  const label = portalLabels[portal];
  const router = useRouter();
  const { refresh } = useAuth();
  const catalog = usePolling<Catalog>(teacher && register ? "/catalog" : null, 0);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [university, setUniversity] = useState("");
  const [degree, setDegree] = useState("");
  const [bio, setBio] = useState("");
  const [subjectIds, setSubjectIds] = useState<string[]>([]);
  const [adultConfirmed, setAdultConfirmed] = useState(false);
  const [fullTimeConfirmed, setFullTimeConfirmed] = useState(false);
  const [notEmployedConfirmed, setNotEmployedConfirmed] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const generation = useRef(0);
  useEffect(() => { generation.current += 1; active.current = true; return () => { generation.current += 1; active.current = false; }; }, [portal, mode]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    if (!username.trim() || !password) { setError("请输入账号和密码。"); return; }
    if (register) {
      if (!/^[A-Za-z0-9._-]{3,32}$/.test(username.trim())) { setError("账号需为 3—32 位字母、数字、下划线、点或短横线。"); return; }
      if (Array.from(displayName.trim()).length < 2 || Array.from(displayName.trim()).length > 30) { setError("昵称需为 2—30 个字。"); return; }
      if (Array.from(password).length < 10 || Array.from(password).length > 128) { setError("密码长度需为 10—128 个字符。"); return; }
      if (password !== confirmPassword) { setError("两次输入的密码不一致。"); return; }
      if (!adultConfirmed || !termsAccepted) { setError("请确认你已满 18 周岁，并阅读同意服务条款与隐私政策。"); return; }
      if (teacher && (Array.from(university.trim()).length < 2 || !degree || Array.from(bio.trim()).length < 20 || !subjectIds.length || !fullTimeConfirmed || !notEmployedConfirmed)) { setError("请填写学校、在读层次、至少 20 字的擅长方向，选择可答科目，并确认全日制在校及非在职资格。"); return; }
    }
    const attempt = ++generation.current;
    setBusy(true);
    try {
      const payload = register ? { username: username.trim(), displayName: displayName.trim(), password, confirmPassword, adultConfirmed, termsAccepted, ...(teacher ? { university: university.trim(), degree, bio: bio.trim(), subjectIds, fullTimeConfirmed, notEmployedConfirmed } : {}) } : { username: username.trim(), password, remember };
      await post<{ user: User }>(`/${portal}/auth/${mode}`, payload);
      if (!active.current || attempt !== generation.current) return;
      await refresh();
      if (!active.current || attempt !== generation.current) return;
      router.push(portalPath(portal));
      router.refresh();
    } catch (error) { if (active.current && attempt === generation.current) setError(messageOf(error)); }
    finally { if (active.current && attempt === generation.current) setBusy(false); }
  }
  return <div className={`auth-page ${teacher && register ? "teacher-register-page" : ""}`}><div className="auth-page-title"><h1>{portal === "admin" ? "登录管理后台" : register ? "开启你的研伴学习之旅" : "欢迎回到研伴答疑"}</h1><p>{portal === "admin" ? "仅限获授权的管理员使用" : register ? "用一个账号，连接每一次认真思考" : "登录你的账号，继续一起把问题想明白"}</p></div><section className={`auth-card ${teacher && register ? "auth-card-wide" : ""}`} aria-label={`${label}${register ? "注册" : "登录"}`}>{portal !== "admin" ? <nav className="auth-portal-tabs" aria-label="登录身份"><Link href={portalPath("student", mode)} className={portal === "student" ? "active" : ""} aria-current={portal === "student" ? "page" : undefined}>学生{register ? "注册" : "登录"}</Link><Link href={portalPath("teacher", mode)} className={portal === "teacher" ? "active" : ""} aria-current={portal === "teacher" ? "page" : undefined}>教师{register ? "注册" : "登录"}</Link></nav> : <div className="auth-admin-title">管理员账号登录</div>}<form className="auth-form" onSubmit={submit} noValidate><fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><div className="auth-fields-grid"><div className="auth-field"><label htmlFor="username">账号</label><input id="username" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} maxLength={32} placeholder={register ? "设置你的账号" : "请输入账号"} required />{register && <p className="auth-field-help">3—32 位字母、数字或 . _ -，账号不区分大小写。</p>}</div>{register && <div className="auth-field"><label htmlFor="display-name">昵称</label><input id="display-name" value={displayName} onChange={event => setDisplayName(event.target.value)} autoComplete="nickname" maxLength={30} placeholder="你希望伙伴如何称呼你" required /></div>}<PasswordField id="password" label="密码" value={password} onChange={setPassword} login={!register} disabled={busy} />{register && <PasswordField id="confirm-password" label="确认密码" value={confirmPassword} onChange={setConfirmPassword} confirmation disabled={busy} />}{teacher && register && <><div className="auth-field"><label htmlFor="university">学校</label><input id="university" value={university} onChange={event => setUniversity(event.target.value)} maxLength={100} placeholder="填写当前就读的学校" required /></div><div className="auth-field"><label htmlFor="degree">在读层次</label><select id="degree" value={degree} onChange={event => setDegree(event.target.value)} required><option value="">请选择在读层次</option><option value="UNDERGRADUATE">本科生</option><option value="MASTER">硕士研究生</option><option value="DOCTORATE">博士研究生</option></select></div><div className="auth-field auth-full-width"><label htmlFor="bio">擅长方向</label><textarea id="bio" value={bio} onChange={event => setBio(event.target.value)} maxLength={500} rows={3} placeholder="介绍你擅长的知识点、解题方法及能够帮助同学的具体方向（至少 20 字）" required /><p className="auth-field-help">{bio.length}/500</p></div><div className="auth-field auth-full-width"><span className="auth-field-label">可答科目</span>{catalog.error ? <ErrorNotice error={catalog.error} retry={() => void catalog.refresh()} /> : catalog.loading ? <p className="auth-field-help" role="status">正在读取科目…</p> : <div className="auth-subject-options" role="group" aria-label="可答科目">{catalog.data?.subjects.map(subject => <label key={subject.id} className={subjectIds.includes(subject.id) ? "selected" : ""}><input type="checkbox" checked={subjectIds.includes(subject.id)} onChange={event => setSubjectIds(current => event.target.checked ? [...current, subject.id] : current.filter(id => id !== subject.id))} />{subject.name}</label>)}</div>}</div></>}</div>{!register ? <div className="auth-options"><label className="auth-checkbox"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />记住登录状态</label><span>账号密码安全登录</span></div> : <div className="auth-agreements"><label className="auth-checkbox"><input type="checkbox" checked={adultConfirmed} onChange={event => setAdultConfirmed(event.target.checked)} />我已满18周岁，是在校大学生或研究生</label>{teacher && <><label className="auth-checkbox"><input type="checkbox" checked={fullTimeConfirmed} onChange={event => setFullTimeConfirmed(event.target.checked)} />我是全日制在校大学生或研究生</label><label className="auth-checkbox"><input type="checkbox" checked={notEmployedConfirmed} onChange={event => setNotEmployedConfirmed(event.target.checked)} />我目前非在职，符合答疑资格要求</label></>}<label className="auth-checkbox terms-checkbox"><input type="checkbox" checked={termsAccepted} onChange={event => setTermsAccepted(event.target.checked)} /><span>我已阅读并同意<Link href="/terms" target="_blank" rel="noreferrer">《服务条款》</Link>与<Link href="/privacy" target="_blank" rel="noreferrer">《隐私政策》</Link></span></label></div>}<ErrorNotice error={error} /><button className="button primary full auth-submit" type="submit" disabled={busy || (teacher && register && !catalog.data)}>{busy ? register ? "正在创建账号…" : "正在登录…" : portal === "admin" ? "登录管理后台" : register ? `注册并进入${label}端` : `登录${label}端`}</button>{teacher && register && <p className="auth-review-note">资格信息由本人声明。提交后等待平台审核，审核通过后可接收答疑邀请。</p>}</fieldset>{portal !== "admin" && <p className="auth-mode-switch">{register ? "已经有账号？" : "还没有账号？"}<Link href={portalPath(portal, register ? "login" : "register")}>{register ? "立即登录" : "立即注册"}<span aria-hidden> →</span></Link></p>}</form></section><p className="auth-bottom-note">{portal === "admin" ? "请妥善保管管理账号与密码" : "一个具体问题，一次认真交流"}</p></div>;
}
