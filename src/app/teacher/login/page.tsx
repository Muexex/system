import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
export const metadata: Metadata = { title: "教师登录" };
export default function TeacherLoginPage() { return <AuthForm portal="teacher" mode="login" />; }
