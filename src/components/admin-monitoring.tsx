"use client";

import { ErrorNotice, Loading } from "@/components/site-shell";
import { usePolling } from "@/lib/client";

interface MonitorEvent {
  timestamp: string; level: "info" | "warn" | "error"; kind: string; code?: string;
  requestId?: string; operation?: string; digest?: string; status?: number;
  signal?: string; exitCode?: number; attempt?: number; category?: string;
}
interface MonitoringData {
  uptimeSeconds: number;
  runtime: { node: string; next: string; pid: number; platform: string; arch: string };
  memory: { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
  recentEvents: MonitorEvent[];
  log: { enabled: true; available: boolean; rotationFiles: number; maxBytes: number };
}

const labels: Record<string, string> = {
  SERVER_STARTED: "服务启动", PROCESS_STARTED: "服务进程启动", PROCESS_EXIT: "服务进程退出",
  RESTART_SCHEDULED: "计划重启", RESTART_LIMIT: "重启次数达到上限", STOP_REQUESTED: "收到停止请求",
  FATAL_ERROR: "进程发生致命错误", API_ERROR: "服务接口异常", REQUEST_ERROR: "请求校验异常", CLIENT_ERROR: "页面渲染异常",
  INVALID_ORIGIN: "跨站来源被拒绝", FORBIDDEN: "权限校验拒绝", RATE_LIMITED: "请求频率超限",
  UNAUTHENTICATED: "未登录请求", INVALID_INPUT: "输入校验失败", INVALID_REQUEST: "请求校验失败",
  DATABASE_ERROR: "数据库异常", FILESYSTEM_ERROR: "文件系统异常", RUNTIME_ERROR: "运行时异常",
  TIMEOUT_ERROR: "请求超时", CHILD_EXIT: "子进程退出", CHILD_SIGNAL: "子进程收到退出信号",
  SPAWN_FAILED: "启动失败", OPERATOR_STOP: "主动停止", CLIENT_RENDER_ERROR: "页面渲染失败",
};

function EventList({ events, empty }: { events: MonitorEvent[]; empty: string }) {
  return events.length ? <div>{events.map((event, index) => <article className="admin-metric" key={`${event.timestamp}:${index}`} style={{ display: "block", overflowWrap: "anywhere" }}><div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}><strong>{labels[event.code || ""] || labels[event.kind] || event.code || event.kind}</strong><span className="caption">{event.level === "error" ? "异常" : event.level === "warn" ? "警告" : "记录"}{event.status ? ` · HTTP ${event.status}` : ""}</span></div><p className="caption" style={{ margin: "5px 0 0" }}>{new Date(event.timestamp).toLocaleString("zh-CN", { hour12: false })}{event.signal ? ` · 信号 ${event.signal}` : ""}{event.exitCode !== undefined ? ` · 退出码 ${event.exitCode}` : ""}{event.attempt !== undefined ? ` · 重启次数 ${event.attempt}` : ""}</p>{event.requestId && <p className="caption" style={{ margin: "5px 0 0", fontSize: 11 }}>请求编号 {event.requestId}</p>}</article>)}</div> : <p className="caption">{empty}</p>;
}

export function MonitoringPanel() {
  const poll = usePolling<MonitoringData>("/admin/monitoring", 10_000);
  const data = poll.data;
  const recent = [...(data?.recentEvents ?? [])].reverse();
  const errors = recent.filter(event => event.level !== "info" && !["PROCESS_EXIT", "STOP_REQUESTED", "RESTART_SCHEDULED", "RESTART_LIMIT"].includes(event.kind)).slice(0, 10);
  const exits = recent.filter(event => ["PROCESS_EXIT", "STOP_REQUESTED", "RESTART_SCHEDULED", "RESTART_LIMIT", "FATAL_ERROR"].includes(event.kind)).slice(0, 10);
  return <><div className="section-title"><div><h2>运行监控</h2><p>运行状态、安全异常与进程退出原因，仅展示必要的诊断摘要。</p></div><button className="button secondary small" type="button" onClick={() => void poll.refresh()}>刷新监控</button></div><ErrorNotice error={poll.error} retry={() => void poll.refresh()} />{poll.loading && !data ? <Loading text="正在读取运行监控…" /> : data && <>{!data.log.available && <div className="notice error" role="alert">诊断日志暂时无法写入，请检查服务器日志目录权限与磁盘空间。</div>}<div className="stats-grid"><div className="card stat-card"><p>服务运行时长</p><div className="stat-value">{Math.floor(data.uptimeSeconds / 60)}<small> 分钟</small></div><small>当前进程 PID {data.runtime.pid}</small></div><div className="card stat-card"><p>进程内存 RSS</p><div className="stat-value">{(data.memory.rssBytes / 1024 / 1024).toFixed(1)}<small> MB</small></div><small>已使用堆内存 {(data.memory.heapUsedBytes / 1024 / 1024).toFixed(1)} MB</small></div><div className="card stat-card"><p>Node.js / Next.js</p><div style={{ fontSize: 22, fontWeight: 700, margin: "16px 0" }}>{data.runtime.node} / {data.runtime.next}</div><small>{data.runtime.platform} · {data.runtime.arch}</small></div><div className="card stat-card"><p>诊断日志</p><div style={{ fontSize: 22, fontWeight: 700, margin: "16px 0" }}>{data.log.available ? "可用" : "写入异常"}</div><small>自动轮换 · {data.log.rotationFiles} 份留存</small></div></div><div className="admin-layout"><section className="card"><h3>最近安全与运行异常</h3><EventList events={errors} empty="最近没有记录到安全或运行异常。" /></section><section className="card"><h3>退出与重启原因</h3><EventList events={exits} empty="最近没有进程退出或重启记录。" /></section></div></>}</>;
}
