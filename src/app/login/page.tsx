"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Empty, ErrorNotice, Loading, useAuth } from "@/components/site-shell";
import { messageOf, post, usePolling, type Role, type User } from "@/lib/client";

export default function LoginPage() {
  const { refresh } = useAuth();
  const router = useRouter();
  const me = usePolling<{ user: User | null; demoMode: boolean; accounts: User[] }>("/me", 0);
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  async function login(account: User) { setPending(account.id); setError(""); try { await post("/login", { accountId: account.id }); await refresh(); router.push(account.role === "ANSWERER" ? "/answer" : account.role === "ADMIN" ? "/admin" : "/"); } catch (e) { setError(messageOf(e)); } finally { setPending(""); } }
  if (me.loading) return <Loading text="正在读取演示账号…" />;
  if (me.data && !me.data.demoMode) return <Empty title="演示登录已关闭" text="当前未开放正式登录。请联系环境管理员确认试用配置。" />;
  const roles: { role: Role; title: string; icon: string; description: string }[] = [{ role: "ASKER", title: "我是提问者", icon: "?", description: "带着考研学习中的具体问题，寻找在线答疑伙伴。" }, { role: "ANSWERER", title: "我是答疑者", icon: "✧", description: "成年、非在职的全日制在校伙伴；主动上线后接收邀请。" }, { role: "ADMIN", title: "管理测试平台", icon: "▦", description: "查看真实答疑统计，管理测试账号与可答科目。" }];
  return <><div className="login-intro"><div className="eyebrow">原型测试 · 免费体验</div><h1>选择你的体验身份</h1><p>以下全部为虚构测试账号。请选择一个身份，开启一次真实的在线答疑。</p></div><ErrorNotice error={error || me.error} retry={me.error ? () => void me.refresh() : undefined} /><div className="login-grid">{roles.map(role => <section className="card login-role" key={role.role}><div className="role-mark" aria-hidden>{role.icon}</div><h2>{role.title}</h2><p>{role.description}</p><div className="account-buttons">{me.data?.accounts.filter(account => account.role === role.role).map(account => <button key={account.id} className={`button ${role.role === "ASKER" ? "primary" : "secondary"} full`} disabled={Boolean(pending)} onClick={() => void login(account)}>{pending === account.id ? "正在登录…" : `以${account.name}登录`}</button>)}</div></section>)}</div><div className="notice">想体验双方互动？请打开两个独立浏览器会话：一个登录提问者，另一个登录答疑者。答疑者主动上线后，再发起提问。</div></>;
}
