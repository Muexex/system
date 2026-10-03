"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function GlobalError({ error, retry, reset }: {
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
  return <html lang="zh-CN"><body style={{ margin: 0, color: "#25382d", background: "#f5f7f3", fontFamily: "system-ui, sans-serif" }}>
    <title>页面暂时无法加载 · 研伴答疑</title>
    <main role="alert" style={{ maxWidth: 560, margin: "15vh auto", padding: 28, textAlign: "center" }}>
      <p>研伴答疑</p>
      <h1>页面暂时无法加载</h1>
      <p>请重试或返回首页。如果问题持续，可以向管理员提供下方编号。</p>
      {digest && <p>错误编号：<code>{digest}</code></p>}
      <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: 12 }}>
        <button type="button" onClick={() => (retry || reset)()} style={{ font: "inherit", padding: "12px 22px", borderRadius: 8, border: 0, background: "#2c6045", color: "white", cursor: "pointer" }}>重新加载</button>
        <Link href="/" prefetch={false} onClick={(event) => { event.preventDefault(); window.location.assign("/"); }} style={{ padding: "12px 22px", borderRadius: 8, background: "white", color: "#2c6045", textDecoration: "none" }}>返回首页</Link>
      </div>
    </main>
  </body></html>;
}
