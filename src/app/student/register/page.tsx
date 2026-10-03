import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
export const metadata: Metadata = { title: "学生注册" };
export default function StudentRegisterPage() { return <AuthForm portal="student" mode="register" />; }
