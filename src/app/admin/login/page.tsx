import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
export const metadata: Metadata = { title: "管理员登录" };
export default function AdminLoginPage() { return <AuthForm portal="admin" mode="login" />; }
