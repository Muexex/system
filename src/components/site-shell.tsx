"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, messageOf, portalForPath, portalPath, post, type Portal, type Role, type User } from "@/lib/client";

type Auth = { user: User | null; loading: boolean; error: string; portal: Portal; refresh: () => Promise<void> };
const AuthContext = createContext<Auth>({ user: null, loading: true, error: "", portal: "student", refresh: async () => {} });
export function useAuth() { return useContext(AuthContext); }
const roleLabels = { ASKER: "学生", ANSWERER: "教师", ADMIN: "管理员" };
const portalRoles: Record<Portal, Role> = { student: "ASKER", teacher: "ANSWERER", admin: "ADMIN" };

function Brand({ href = "/" }: { href?: string }) { return <Link href={href} className="brand" aria-label="研伴答疑首页"><span className="brand-mark">研</span><span>研伴答疑<small>让问题，得到回应</small></span></Link>; }
function PublicHeader({ admin }: { admin: boolean }) { return <header className="public-header"><div className="public-header-inner"><Brand /><nav aria-label="网站导航">{admin ? <Link href="/">返回首页</Link> : <><Link href="/#features" className="desktop-public-link">平台功能</Link><Link href="/#workflow" className="desktop-public-link">答疑流程</Link><Link href="/student/login" className="public-student-link">学生登录</Link><Link href="/teacher/login" className="button secondary small">教师登录</Link></>}</nav></div></header>; }
function PublicFooter() { return <footer className="public-footer"><div><Link href="/terms">服务条款</Link><span>·</span><Link href="/privacy">隐私政策</Link><span>·</span><Link href="/">关于研伴答疑</Link></div><p>© 2026 研伴答疑 · 面向成年在校大学生的实时学习交流</p></footer>; }

export function SiteShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const portal = portalForPath(pathname);
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<{ portal: Portal; user: User | null; loading: boolean; error: string }>({ portal, user: null, loading: true, error: "" });
  const [leaving, setLeaving] = useState(false);
  const generation = useRef(0);
  const activePortal = useRef(portal);
  activePortal.current = portal;
  const refresh = useCallback(async () => {
    const attempt = ++generation.current;
    setSnapshot(previous => ({ portal, user: previous.portal === portal ? previous.user : null, loading: true, error: "" }));
    try {
      const me = await api<{ user: User | null; portal: Portal }>("/me", { headers: { "X-Yanban-Portal": portal } });
      if (attempt !== generation.current || activePortal.current !== portal) return;
      const user = me.user && me.user.role === portalRoles[portal] && (!me.user.portal || me.user.portal === portal) ? me.user : null;
      setSnapshot({ portal, user, loading: false, error: "" });
    } catch (error) { if (attempt === generation.current && activePortal.current === portal) setSnapshot({ portal, user: null, loading: false, error: messageOf(error) }); }
  }, [portal]);
  useEffect(() => { void refresh(); return () => { generation.current += 1; }; }, [refresh]);
  const auth = snapshot.portal === portal ? snapshot : { portal, user: null, loading: true, error: "" };
  const { user, error } = auth;
  useEffect(() => { if (portal !== "teacher" || user?.role !== "ANSWERER") return; const timer = setInterval(() => { void api("/heartbeat", { method: "POST", body: "{}", headers: { "X-Yanban-Portal": "teacher" } }).catch(() => {}); }, 10000); return () => clearInterval(timer); }, [portal, user?.id, user?.role]);
  async function logout() {
    const logoutPortal = portal;
    setLeaving(true);
    try { await post(`/${logoutPortal}/auth/logout`); generation.current += 1; setSnapshot({ portal: logoutPortal, user: null, loading: false, error: "" }); router.push(portalPath(logoutPortal, "login")); router.refresh(); }
    catch (error) { setSnapshot(previous => ({ ...previous, error: messageOf(error) })); }
    finally { setLeaving(false); }
  }
  const isPublic = pathname === "/" || pathname === "/login" || pathname === "/terms" || pathname === "/privacy" || /\/(login|register)$/.test(pathname);
  const context = { ...auth, refresh };
  if (isPublic) return <AuthContext.Provider value={context}><div className="public-shell"><PublicHeader admin={portal === "admin"} /><main className={`public-main ${pathname === "/" ? "landing-main" : ""}`}>{children}</main><PublicFooter /></div></AuthContext.Provider>;
  const nav = portal === "admin" ? [{ href: "/admin", label: "管理概览", icon: "▦" }] : portal === "teacher" ? [{ href: "/teacher", label: "答疑工作台", icon: "◷" }, { href: "/teacher/history", label: "答疑记录", icon: "≡" }, { href: "/teacher/profile", label: "个人资料", icon: "○" }] : [{ href: "/student", label: "发现答疑", icon: "⌂" }, { href: "/student/ask", label: "发起提问", icon: "+" }, { href: "/student/history", label: "答疑记录", icon: "≡" }, { href: "/student/profile", label: "个人资料", icon: "○" }];
  const portalLabel = portal === "admin" ? "管理后台" : portal === "teacher" ? "教师空间" : "学生空间";
  return <AuthContext.Provider value={context}><div className="app-shell"><aside className="sidebar"><Brand href={portalPath(portal)} /><div className="portal-badge"><span className="status-dot" />{portalLabel}</div><nav aria-label="主导航">{nav.map(item => <Link key={item.href} className={`nav-link ${pathname === item.href ? "active" : ""}`} href={item.href}><span aria-hidden>{item.icon}</span>{item.label}</Link>)}</nav><div className="sidebar-note"><span className="note-icon">✧</span><p>一个问题，一次交流。<br />认真理解，一起进步。</p><small>面向成年在校大学生</small></div><div className="sidebar-user">{user ? <><span className="avatar small">{user.name.slice(0, 1)}</span><div><strong>{user.name}</strong><small>{roleLabels[user.role]}</small></div><button className="icon-button" onClick={logout} disabled={leaving} aria-label="退出登录" title="退出登录">↪</button></> : <Link className="button secondary full" href={portalPath(portal, "login")}>前往登录</Link>}</div></aside><div className="main-wrap"><header className="topbar"><Link className="mobile-brand" href={portalPath(portal)}>研伴答疑</Link><span className="topbar-context">{portalLabel} · 实时在线答疑</span><div className="topbar-right"><span className="portal-label">{portalLabel}</span>{user ? <Link className="user-tag" href={portal === "admin" ? "/admin" : portalPath(portal, "profile")}>{user.name}</Link> : <Link href={portalPath(portal, "login")}>登录</Link>}</div></header><nav className="mobile-nav" aria-label="移动端导航">{nav.map(item => <Link key={item.href} className={pathname === item.href ? "active" : ""} href={item.href}>{item.label}</Link>)}{user && <button onClick={logout} disabled={leaving}>退出</button>}</nav><main className="main-content">{error && <ErrorNotice error={error} retry={() => void refresh()} />}{children}</main><footer>研伴答疑 · 实时在线学习交流<span><Link href="/terms">服务条款</Link> · <Link href="/privacy">隐私政策</Link></span></footer></div></div></AuthContext.Provider>;
}

export function AuthGate({ children, role }: { children: ReactNode; role?: Role }) {
  const { user, loading, error, portal } = useAuth();
  if (loading) return <Loading text="正在确认登录状态…" />;
  if (!user) return <Empty title={error ? "暂时无法确认登录状态" : "登录后继续"} text={error || "请登录当前门户，继续你的答疑与学习交流。"} action={<Link className="button primary" href={portalPath(portal, "login")}>前往登录</Link>} />;
  if (role && user.role !== role) { const needed = role === "ASKER" ? "student" : role === "ANSWERER" ? "teacher" : "admin"; return <Empty title="请使用相应门户" text={`此页面需要${roleLabels[role]}身份。`} action={<Link className="button secondary" href={portalPath(needed, "login")}>前往{roleLabels[role]}登录</Link>} />; }
  return <>{children}</>;
}
export function PageHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) { return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>; }
export function Loading({ text = "正在加载…" }: { text?: string }) { return <div className="loading-state" role="status"><span className="spinner" />{text}</div>; }
export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) { return <div className="empty-state"><div className="empty-symbol" aria-hidden>◌</div><h2>{title}</h2>{text && <p>{text}</p>}{action}</div>; }
export function ErrorNotice({ error, retry }: { error: string; retry?: () => void }) { return error ? <div className="notice error" role="alert">{error}{retry && <button type="button" className="text-button" onClick={retry}>重试</button>}</div> : null; }
export function StatusPill({ status }: { status: string }) { const labels: Record<string, string> = { AVAILABLE: "可接单", BUSY: "答疑中", OFFLINE: "离线" }; return <span className={`status-pill ${status.toLowerCase()}`}><span className="status-dot" />{labels[status] || status}</span>; }
