"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function PageError({ error, retry, reset }: {
  error: Error & { digest?: string };
  retry?: () => void;
  reset: () => void;
}) {
  const digest = typeof error.digest === "string" && /^[a-f\d]{1,64}$/i.test(error.digest) ? error.digest : undefined;
  useEffect(() => {
    void fetch("/api/client-errors", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digest, path: window.location.pathname }),
    }).catch(() => {});
  }, [digest]);
  return <section className="empty-state" role="alert">
    <div className="empty-symbol" aria-hidden="true">!</div>
    <h1>页面暂时无法加载</h1>
    <p>请重试或返回首页。如果问题持续，可以向管理员提供下方编号。</p>
    {digest && <p>错误编号：<code>{digest}</code></p>}
    <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: 12 }}>
      <button type="button" className="button primary" onClick={() => (retry || reset)()}>重新加载</button>
      <Link className="button secondary" href="/" prefetch={false} onClick={(event) => { event.preventDefault(); window.location.assign("/"); }}>返回首页</Link>
    </div>
  </section>;
}
