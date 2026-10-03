import PortalRoom from "@/components/portal-room";
export default async function RoomPage({ params }: { params: Promise<{ sessionId: string }> }) { const { sessionId } = await params; return <PortalRoom sessionId={sessionId} portal="teacher" />; }
