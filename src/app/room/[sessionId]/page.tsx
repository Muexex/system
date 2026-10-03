import { redirect } from "next/navigation";
export default async function LegacyPage({ params }: { params: Promise<{ sessionId: string }> }) { const { sessionId } = await params; redirect(`/student/room/${sessionId}`); }
