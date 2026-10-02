"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, messageOf, post, type Role, type User } from "@/lib/client";

type Auth = { user: User | null; loading: boolean; error: string; demoMode: boolean; refresh: () => Promise<void> };
const AuthContext = createContext<Auth>({ user: null, loading: true, error: "", demoMode: false, refresh: async () => {} });
export function useAuth() { return useContext(AuthContext); }
const roleLabels = { ASKER: "提问者", ANSWERER: "答疑者", ADMIN: "管理员" };

export function SiteShell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [demoMode, setDemoMode] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  async function refresh() { try { const me = await api<{ user: User | null; demoMode: boolean }>("/me"); setUser(me.user); setDemoMode(me.demoMode); setError(""); } catch (e) { setError(messageOf(e)); } finally { setLoading(false); } }
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (user?.role !== "ANSWERER") return; const timer = setInterval(() => { void post("/heartbeat").catch(() => {}); }, 10000); return () => clearInterval(timer); }, [user?.id, user?.role]);
  async function logout() { setLeaving(true); try { await post("/logout"); setUser(null); router.push("/login"); router.refresh(); } catch (e) { setError(messageOf(e)); } finally { setLeaving(false); } }
  const nav = [{ href: "/", label: "发现答疑", icon: "⌂" }, ...(user?.role === "ANSWERER" ? [{ href: "/answer", label: "答疑工作台", icon: "◷" }] : user?.role === "ADMIN" ? [{ href: "/admin", label: "管理概览", icon: "▦" }] : [{ href: "/ask", label: "发起提问", icon: "+" }]), ...(user ? [{ href: "/history", label: "答疑记录", icon: "≡" }] : [])];
  return <AuthContext.Provider value={{ user, loading, error, demoMode, refresh }}><div className="app-shell"><aside className="sidebar"><Link href="/" className="brand" aria-label="研伴答疑首页"><span className="brand-mark">研</span><span>研伴答疑<small>让问题，得到回应</small></span></Link><div className="prototype-badge"><span className="status-dot" />原型测试 · 免费体验</div><nav aria-label="主导航">{nav.map(item => <Link key={item.href} className={`nav-link ${pathname === item.href ? "active" : ""}`} href={item.href}><span aria-hidden>{item.icon}</span>{item.label}</Link>)}</nav><div className="sidebar-note"><span className="note-icon">✧</span><p>一个问题，一次交流。<br />与在校伙伴一起理清思路。</p><small>测试资料均为虚构<br />仅面向成年在校大学生</small></div><div className="sidebar-user">{user ? <><span className="avatar small">{user.name.slice(-1)}</span><div><strong>{user.name}</strong><small>{roleLabels[user.role]} · 演示账号</small></div><button className="icon-button" onClick={logout} disabled={leaving} aria-label="退出登录" title="退出登录">↪</button></> : <Link className="button secondary full" href="/login">登录体验</Link>}</div></aside><div className="main-wrap"><header className="topbar"><Link className="mobile-brand" href="/">研伴答疑</Link><span className="topbar-context">实时在线 · 按次答疑</span><div className="topbar-right"><span className="test-label">原型测试 · 免费体验</span>{user ? <span className="user-tag">{user.name}</span> : <Link href="/login">登录</Link>}</div></header><nav className="mobile-nav" aria-label="移动端导航">{nav.map(item => <Link key={item.href} className={pathname === item.href ? "active" : ""} href={item.href}>{item.label}</Link>)}{user && <button onClick={logout} disabled={leaving}>退出</button>}</nav><main className="main-content">{error && <div className="notice error" role="alert">{error}<button className="text-button" onClick={() => void refresh()}>重试</button></div>}{children}</main><footer>研伴答疑 · 成年在校伙伴之间的即时交流<span>测试账号与资料均为虚构</span></footer></div></div></AuthContext.Provider>;
}

export function AuthGate({ children, role }: { children: ReactNode; role?: Role }) {
  const { user, loading, error } = useAuth();
  if (loading) return <Loading text="正在确认登录状态…" />;
  if (!user) return <Empty title={error ? "暂时无法确认登录状态" : "登录后继续"} text={error || "请选择一个演示账号，体验真实的提问与答疑流程。"} action={<Link className="button primary" href="/login">前往登录</Link>} />;
  if (role && user.role !== role) return <Empty title="此页面需要相应角色" text={`当前账号是${roleLabels[user.role]}，请使用${roleLabels[role]}账号进入。`} action={<Link className="button secondary" href="/login">切换演示账号</Link>} />;
  return <>{children}</>;
}
export function PageHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) { return <div className="page-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>; }
export function Loading({ text = "正在加载…" }: { text?: string }) { return <div className="loading-state" role="status"><span className="spinner" />{text}</div>; }
export function Empty({ title, text, action }: { title: string; text?: string; action?: ReactNode }) { return <div className="empty-state"><div className="empty-symbol" aria-hidden>◌</div><h2>{title}</h2>{text && <p>{text}</p>}{action}</div>; }
export function ErrorNotice({ error, retry }: { error: string; retry?: () => void }) { return error ? <div className="notice error" role="alert">{error}{retry && <button type="button" className="text-button" onClick={retry}>重试</button>}</div> : null; }
export function StatusPill({ status }: { status: string }) { const labels: Record<string, string> = { AVAILABLE: "可接单", BUSY: "答疑中", OFFLINE: "离线" }; return <span className={`status-pill ${status.toLowerCase()}`}><span className="status-dot" />{labels[status] || status}</span>; }
