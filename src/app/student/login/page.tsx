import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
export const metadata: Metadata = { title: "学生登录" };
export default function StudentLoginPage() { return <AuthForm portal="student" mode="login" />; }
