"use client";

import { HistoryList } from "@/components/history-list";
import { AuthGate, ErrorNotice, Loading, PageHeading } from "@/components/site-shell";
import { usePolling, type HistoryItem } from "@/lib/client";

export default function PortalHistory({ portal }: { portal: "student" | "teacher" }) {
  return <AuthGate role={portal === "student" ? "ASKER" : "ANSWERER"}><History portal={portal} /></AuthGate>;
}

function History({ portal }: { portal: "student" | "teacher" }) {
  const poll = usePolling<{ history: HistoryItem[] }>("/history");
  return <><PageHeading eyebrow={portal === "student" ? "学生中心" : "教师中心"} title="答疑记录" description="查看自己参与的问题、交流时间、消息与反馈。" /><ErrorNotice error={poll.error} retry={() => void poll.refresh()} />{poll.loading && !poll.data ? <Loading /> : poll.data && <HistoryList items={poll.data.history} portal={portal} />}</>;
}
