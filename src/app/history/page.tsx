"use client";

import { HistoryList } from "@/components/history-list";
import { AuthGate, ErrorNotice, Loading, PageHeading } from "@/components/site-shell";
import { usePolling, type HistoryItem } from "@/lib/client";

export default function HistoryPage() { return <AuthGate><History /></AuthGate>; }
function History() { const poll = usePolling<{ history: HistoryItem[] }>("/history"); return <><PageHeading eyebrow="属于你的交流记录" title="答疑记录" description="查看本账号参与的问题、消息与反馈。" /><ErrorNotice error={poll.error} retry={() => void poll.refresh()} />{poll.loading && !poll.data ? <Loading /> : poll.data && <HistoryList items={poll.data.history} />}</>; }
