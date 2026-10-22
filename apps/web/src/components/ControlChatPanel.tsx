import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { InlineFeedback } from "./InlineFeedback";
import "./ControlChatPanel.css";

type History = {
  items: Array<{ id: string; text: string; reply: string; state: string; source: string; createdAt: string }>;
  pending: { id: string; summary: string; expiresAt: string } | null;
  choices: Array<{ text: string; label: string }>;
  timezone: string;
};
// Only service-local links returned by Control become clickable; user text stays text.
function Reply({ text }: { text: string }) {
  return <>{text.split(/(https?:\/\/[^\s]+)/).map((part, i) => {
    if (/^https?:\/\//.test(part)) {
      try { const url = new URL(part); if (url.origin === window.location.origin || url.hostname === "bsqr.kz") return <Link key={i} to={url.pathname + url.search}>{({ "/tasks": "Открыть задачи", "/today": "Открыть обзор", "/stats": "Открыть статистику", "/contacts": "Открыть клиентов" } as Record<string,string>)[url.pathname] || "Открыть в BasQar"}</Link>; } catch { /* render invalid URLs as text */ }
    }
    return part;
  })}</>;
}
export function ControlChatPanel({ canManageAccess = true }: { canManageAccess?: boolean }) {
  const [history, setHistory] = useState<History | null>(null), [text, setText] = useState(""), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const sending = useRef(false), retry = useRef<{ text: string; id: string } | null>(null), list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const requestVersion = useRef(0), initialHistoryShown = useRef(false);
  async function load() {
    if (sending.current) return;
    const version = ++requestVersion.current;
    try { const next = await api.controlChatHistory() as History; if (version === requestVersion.current) { setHistory(next); setError(""); } }
    catch (e) { if (version === requestVersion.current) setError(e instanceof Error ? e.message : "Не удалось загрузить Control"); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!history || initialHistoryShown.current) return;
    initialHistoryShown.current = true;
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [history]);
  useEffect(() => {
    if (!history?.items.some(item => item.state === "processing" || item.state === "queued")) return;
    const timer = window.setInterval(() => void load(), 4000);
    return () => window.clearInterval(timer);
  }, [history]);
  async function send(value = text) {
    const command = value.trim();
    if (!command || sending.current) return;
    sending.current = true; ++requestVersion.current; setBusy(true); setError("");
    // Preserve the request ID on a network retry, including confirmation clicks.
    const request = retry.current?.text === command ? retry.current : { text: command, id: crypto.randomUUID() };
    retry.current = request;
    try {
      setHistory(await api.sendControlChat(command, request.id) as History); retry.current = null; setText("");
      requestAnimationFrame(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: "smooth" }); input.current?.focus(); });
    } catch (e) {
      if ((e as { code?: string }).code === "control_busy") retry.current = null;
      setError(e instanceof Error ? e.message : "Не удалось отправить запрос");
    } finally { sending.current = false; setBusy(false); }
  }
  const quick = ["Какие задачи на сегодня?", "Что требует внимания", "Продажи под контролем", "Продажи за неделю", "Найди клиента", "Создай задачу"];
  return <section className="panel control-chat" aria-label="BasQar Control">
    <header className="control-chat-head"><div><span className="control-chat-eyebrow">BASQAR CONTROL</span><h3>Что нужно сделать?</h3><p className="muted">Напишите своими словами. Меню вызывать не нужно. Изменения — после вашего подтверждения.</p></div><div className="control-chat-tools">{canManageAccess && <Link to="/settings?section=control" className="btn secondary">Настройки доступа</Link>}<button type="button" className="btn secondary" disabled={busy || loading} onClick={() => void load()}>Обновить историю</button></div></header>
    {loading ? <p role="status">Загружаем историю…</p> : <>
      {history && <>
        <div className="control-chat-quick" aria-label="Быстрые запросы">{quick.map(command => <button type="button" className="chip" key={command} disabled={busy} onClick={() => void send(command)}>{command}</button>)}</div>
        <div className="control-chat-messages" ref={list} role="log" aria-label="История Control" aria-relevant="additions text">
          {!history.items.length && <div className="control-chat-empty"><b>Управляйте без поиска по разделам</b><p>«Создай задачу встреча с клиентом завтра в 18:00»</p><p className="muted">Здесь сохраняются ваши запросы из платформы и WhatsApp. Ответы содержат только данные, доступные вам.</p></div>}
          {history.items.map(item => <article key={item.id} className="control-chat-turn"><small>{item.source === "WHATSAPP" ? "WhatsApp" : "В платформе"} · {new Date(item.createdAt).toLocaleString("ru-RU", { timeZone: history.timezone, dateStyle: "short", timeStyle: "short" })}</small><div className="control-chat-question">{item.text}</div><div className="control-chat-reply">{item.reply ? <Reply text={item.reply} /> : item.state === "processing" || item.state === "queued" ? "Запрос обрабатывается…" : "Ответ недоступен. Проверьте историю действий перед повтором изменения."}</div></article>)}
        </div>
        {history.pending && <div className="control-chat-confirm"><b>Подтвердите изменение</b><p>{history.pending.summary}</p><div className="actions"><button className="btn" disabled={busy} onClick={() => void send(`Подтвердить ${history.pending!.id.slice(-6)}`)}>Подтвердить</button><button className="btn secondary" disabled={busy} onClick={() => void send("Отмена")}>Отменить</button></div></div>}
        {!!history.choices.length && <div className="control-chat-choices">{history.choices.map(choice => <button className="btn secondary" key={choice.text} disabled={busy} onClick={() => void send(choice.text)}>{choice.label}</button>)}</div>}
        <form className="control-chat-compose" onSubmit={e => { e.preventDefault(); void send(); }}><label htmlFor="control-message">Запрос BasQar Control</label><textarea id="control-message" ref={input} value={text} maxLength={2000} rows={2} placeholder="Например: какие задачи на сегодня?" onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }} /><button className="btn" disabled={busy || !text.trim()}>{busy ? "Обрабатываем…" : "Отправить"}</button></form>
      </>}
      {error && <InlineFeedback kind="error">{error}</InlineFeedback>}
      {!history && <button type="button" className="btn secondary" onClick={() => { setLoading(true); void load(); }}>Проверить доступ</button>}
    </>}
  </section>;
}
