import type { Metadata } from "next";
import { AuthForm } from "@/components/auth-form";
export const metadata: Metadata = { title: "教师注册" };
export default function TeacherRegisterPage() { return <AuthForm portal="teacher" mode="register" />; }
