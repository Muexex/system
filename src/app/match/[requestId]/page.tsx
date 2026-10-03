import { redirect } from "next/navigation";
export default async function LegacyPage({ params }: { params: Promise<{ requestId: string }> }) { const { requestId } = await params; redirect(`/student/match/${requestId}`); }
