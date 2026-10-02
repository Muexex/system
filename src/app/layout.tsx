import type { Metadata } from "next";
import { SiteShell } from "@/components/site-shell";
import "./globals.css";

export const metadata: Metadata = { title: { default: "研伴答疑 · 实时在线答疑", template: "%s · 研伴答疑" }, description: "面向成年在校大学生的实时、按次在线答疑。原型测试，免费体验。" };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="zh-CN"><body><SiteShell>{children}</SiteShell></body></html>; }
