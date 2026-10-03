"use client";

import { useRouter } from "next/navigation";
import Image from "next/image";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AuthGate, ErrorNotice, Loading, PageHeading } from "@/components/site-shell";
import { ApiError, api, messageOf, newKey, post, usePolling, type Catalog, type RequestView } from "@/lib/client";

export default function AskPage() { return <AuthGate role="ASKER"><AskForm /></AuthGate>; }
function AskForm() {
  const catalog = usePolling<Catalog>("/catalog");
  const router = useRouter();
  const [subjectId, setSubjectId] = useState("");
  const [description, setDescription] = useState("");
  const [mode, setMode] = useState<"DIRECT" | "QUICK">("QUICK");
  const [target, setTarget] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const key = useRef<string | null>(null);
  const attachment = useRef<string | null>(null);
  useEffect(() => { const params = new URLSearchParams(window.location.search); setSubjectId(params.get("subject") || ""); if (params.get("answerer")) { setMode("DIRECT"); setTarget(params.get("answerer") || ""); } }, []);
  useEffect(() => { if (!file) { setPreview(""); return; } const url = URL.createObjectURL(file); setPreview(url); return () => URL.revokeObjectURL(url); }, [file]);
  useEffect(() => { if (!subjectId && target && catalog.data) { const person = catalog.data.answerers.find(p => p.id === target); if (person?.subjects.length) setSubjectId(person.subjects[0].id); } }, [catalog.data, target, subjectId]);
  const answerers = catalog.data?.answerers.filter(person => person.enabled && person.subjects.some(s => s.id === subjectId)) || [];
  function chooseFile(next: File | null) { attachment.current = null; setError(""); if (next && (!['image/png', 'image/jpeg', 'image/webp'].includes(next.type) || next.size > 5 * 1024 * 1024)) { setFile(null); setError("图片仅支持 PNG、JPEG、WebP，大小不能超过 5MB。"); return; } setFile(next); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    if (!subjectId) { setError("请选择科目。"); return; }
    if (description.trim().length < 20 || description.trim().length > 2000) { setError("问题描述需为 20—2000 字，请补充具体疑问。"); return; }
    if (mode === "DIRECT" && !target) { setError("请选择一位可接单的教师。"); return; }
    setBusy(true); setError(""); if (!key.current) key.current = newKey();
    try {
      if (file && !attachment.current) { const body = new FormData(); body.append("file", file); const upload = await api<{ attachmentId: string }>("/attachments", { method: "POST", body }); attachment.current = upload.attachmentId; }
      const result = await post<{ request: RequestView }>("/requests", { subjectId, description: description.trim(), mode, ...(mode === "DIRECT" ? { targetAnswererId: target } : {}), ...(attachment.current ? { attachmentId: attachment.current } : {}), idempotencyKey: key.current });
      router.push(`/student/match/${result.request.id}`);
    } catch (e) { if (e instanceof ApiError && e.code === "ACTIVE_REQUEST" && e.requestId) { router.push(`/student/match/${e.requestId}`); } else setError(messageOf(e)); } finally { setBusy(false); }
  }
  return <><PageHeading eyebrow="一次问题 · 一次答疑" title="你想问什么？" description="写清楚具体卡点，让答疑伙伴更快理解你的问题。" /><ErrorNotice error={catalog.error} retry={() => void catalog.refresh()} />{catalog.loading && !catalog.data ? <Loading /> : <div className="form-layout"><form className="card form-card" onSubmit={submit}><fieldset disabled={busy} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}><div className="field"><label htmlFor="subject">答疑科目<span className="required">*</span></label><select id="subject" value={subjectId} onChange={e => { setSubjectId(e.target.value); setTarget(""); }} required><option value="">请选择一个科目</option>{catalog.data?.subjects.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select></div><div className="field"><label htmlFor="question">问题描述<span className="required">*</span></label><textarea id="question" value={description} onChange={e => setDescription(e.target.value)} placeholder="例如：这道极限题我尝试了洛必达法则，但第二步出现了不确定式。想请你帮我理清应该如何变形，以及适用的条件。" minLength={20} maxLength={2000} required rows={6} /><div className="field-meta"><span className="field-help">写出题目、已尝试的思路与具体疑惑。至少 20 字。</span><span className="field-help">{description.length}/2000</span></div></div><div className="field"><label htmlFor="question-image">题目图片 <span className="caption">可选</span></label><div className="upload-area"><p>最多 1 张 · PNG / JPEG / WebP · 不超过 5MB</p><input id="question-image" type="file" accept="image/png,image/jpeg,image/webp" onChange={e => chooseFile(e.target.files?.[0] || null)} />{preview && <><div className="upload-preview"><Image src={preview} alt="待上传题目图片预览" width={100} height={80} unoptimized /></div><button type="button" className="text-button" onClick={() => { setFile(null); attachment.current = null; const input = document.getElementById("question-image") as HTMLInputElement | null; if (input) input.value = ""; }}>移除图片</button></>}</div><p className="field-help">只上传题目；请勿上传身份证、学籍证明或其他个人材料。</p></div><div className="field"><span className="field-label">匹配方式<span className="required">*</span></span><div className="radio-options"><label className={`radio-option ${mode === "QUICK" ? "selected" : ""}`}><input type="radio" name="mode" value="QUICK" checked={mode === "QUICK"} onChange={() => setMode("QUICK")} /><span><strong>快速匹配</strong><small>邀请当前可接单的科目伙伴</small></span></label><label className={`radio-option ${mode === "DIRECT" ? "selected" : ""}`}><input type="radio" name="mode" value="DIRECT" checked={mode === "DIRECT"} onChange={() => setMode("DIRECT")} /><span><strong>指定教师</strong><small>只向你选择的伙伴发出邀请</small></span></label></div></div>{mode === "DIRECT" && <div className="field"><label htmlFor="answerer">选择教师</label><select id="answerer" value={target} onChange={e => setTarget(e.target.value)} required><option value="">请选择可接单的教师</option>{answerers.map(person => <option key={person.id} value={person.id} disabled={person.status !== "AVAILABLE"}>{person.name} · {person.status === "AVAILABLE" ? "可接单" : person.status === "BUSY" ? "答疑中" : "离线"}</option>)}</select>{!answerers.some(p => p.status === "AVAILABLE") && <div className="notice">该科目暂无可接单教师。可以选择快速匹配等待伙伴上线。</div>}</div>}<ErrorNotice error={error} /><button className="button primary full" disabled={busy} type="submit">{busy ? "正在发出请求…" : "发出答疑请求"} <span aria-hidden>↗</span></button><p className="field-help" style={{ textAlign: "center", marginTop: 12 }}>每次只处理一个未结束的问题</p></fieldset></form><aside className="card aside-guide"><h3>让交流更顺畅</h3>{[["1", "问题具体一些", "一次聚焦一个问题，说明你已经试过什么。"], ["2", "等待伙伴接受", "对方接受后，双方进入同一个临时答疑室。"], ["3", "按自己的节奏交流", "没有固定时长，任一方都可以主动结束。"]].map(([n, title, text]) => <div className="guide-step" key={n}><span>{n}</span><div><strong>{title}</strong><p>{text}</p></div></div>)}<div className="divider" /><p className="caption">教师限成年、非在职的全日制在校大学生或研究生。</p></aside></div>}</>;
}
