import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../lib/api";

type Article = {
  id: string;
  title: string;
  slug: string;
  category: string;
  categoryTitle: string;
  content: string;
  isPopular?: boolean;
  relatedRoute?: string | null;
  relatedLabel?: string | null;
  myFeedback?: boolean | null;
};

type Ticket = {
  id: string;
  number: number;
  subject: string;
  status: string;
  statusLabel: string;
  customerUnread?: number;
  closed?: boolean;
};

type Message = {
  id: string;
  senderType: string;
  type: string;
  content: string;
  createdAt: string;
  mine?: boolean;
  attachments?: Array<{ id: string; fileName: string; mimeType: string; kind: string }>;
};

type Catalog = {
  popular: Article[];
  contextual: Article[];
  items: Article[];
};

type View = "home" | "article" | "tickets" | "chat";

function fileToBase64(file: File) {
  return new Promise<{ fileName: string; mimeType: string; contentBase64: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      resolve({
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        contentBase64: comma >= 0 ? result.slice(comma + 1) : result,
      });
    };
    reader.readAsDataURL(file);
  });
}

export function SupportCenter({
  open,
  onClose,
  initialTicketId,
  onUnread,
  canCreateTicket,
}: {
  open: boolean;
  onClose: () => void;
  initialTicketId?: string | null;
  onUnread?: (count: number) => void;
  canCreateTicket: boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [view, setView] = useState<View>("home");
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [article, setArticle] = useState<Article | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [chat, setChat] = useState<{ ticket: Ticket; messages: Message[] } | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadCatalog(q = query) {
    const data = (await api.supportArticles({ q, route: location.pathname + location.search })) as Catalog;
    setCatalog(data);
  }

  async function loadTickets() {
    if (!canCreateTicket) return;
    const data = (await api.supportTickets()) as { items: Ticket[] };
    setTickets(data.items || []);
    onUnread?.(data.items.reduce((sum, item) => sum + Number(item.customerUnread || 0), 0));
  }

  async function openTicket(id: string) {
    const data = (await api.supportTicket(id)) as { ticket: Ticket; messages: Message[] };
    setChat(data);
    setView("chat");
    await loadTickets();
  }

  useEffect(() => {
    if (!open) return;
    setError("");
    void loadTickets();
    if (initialTicketId) void openTicket(initialTicketId);
    else setView("home");
  }, [open, initialTicketId]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      void loadCatalog(query);
    }, query.trim() ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [open, query, location.pathname]);

  useEffect(() => {
    if (!open || view !== "chat" || !chat?.ticket.id) return;
    const timer = window.setInterval(() => {
      void api.supportTicket(chat.ticket.id).then((data: any) => setChat(data));
    }, 4000);
    return () => window.clearInterval(timer);
  }, [open, view, chat?.ticket.id]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [chat?.messages.length, view]);

  const list = useMemo(() => {
    if (query.trim()) return catalog?.items || [];
    const seen = new Set<string>();
    const out: Article[] = [];
    for (const item of [...(catalog?.contextual || []), ...(catalog?.popular || [])]) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
    }
    return out;
  }, [catalog, query]);

  async function openArticle(id: string) {
    const data = (await api.supportArticle(id)) as Article;
    setArticle(data);
    setView("article");
  }

  async function startChat(prefill = "") {
    if (!canCreateTicket) {
      setError("Обращение создаётся из кабинета компании.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const text = prefill.trim() || "Нужна помощь по работе в BasQar.";
      const data = (await api.createSupportTicket({
        message: text,
        route: location.pathname + location.search,
        context: { locale: navigator.language, userAgent: navigator.userAgent },
      })) as { ticket: Ticket; messages: Message[] };
      setChat(data);
      setView("chat");
      setDraft("");
      await loadTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать обращение");
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (!chat || busy) return;
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    setError("");
    try {
      const data = (await api.supportMessage(chat.ticket.id, { content: text })) as { ticket: Ticket; messages: Message[] };
      setChat(data);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не отправлено");
    } finally {
      setBusy(false);
    }
  }

  async function sendFile(file: File) {
    if (!chat) return;
    setBusy(true);
    setError("");
    try {
      const payload = await fileToBase64(file);
      const data = (await api.supportAttachment(chat.ticket.id, payload)) as { ticket: Ticket; messages: Message[] };
      setChat(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Файл не отправлен");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="support-root">
      <button type="button" className="support-backdrop" aria-label="Закрыть поддержку" onClick={onClose} />
      <aside className="support-drawer panel" role="dialog" aria-label="Поддержка BasQar">
        {view === "home" ? (
          <>
            <div className="support-head">
              <div>
                <b>Поддержка BasQar</b>
                <p className="muted">Чем можем помочь?</p>
              </div>
              <button type="button" className="btn secondary" onClick={onClose}>
                Закрыть
              </button>
            </div>
            <label className="support-search">
              Найти ответ
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Например: как подключить WhatsApp"
              />
            </label>
            {error ? <p className="error">{error}</p> : null}
            <p className="muted">{query.trim() ? "Результаты" : catalog?.contextual?.length ? "По этому разделу и популярные вопросы" : "Популярные вопросы"}</p>
            <div className="support-list">
              {list.map((item) => (
                <button key={item.id} type="button" className="support-item" onClick={() => void openArticle(item.id)}>
                  {item.title}
                </button>
              ))}
            </div>
            <div className="support-footer">
              <p className="muted">Не нашли ответ?</p>
              <div className="actions">
                <button type="button" className="btn" disabled={busy || !canCreateTicket} onClick={() => void startChat()}>
                  Написать в поддержку
                </button>
                {canCreateTicket ? (
                  <button type="button" className="btn secondary" onClick={() => setView("tickets")}>
                    Мои обращения
                  </button>
                ) : null}
              </div>
            </div>
          </>
        ) : null}

        {view === "article" && article ? (
          <>
            <div className="support-head">
              <button type="button" className="btn secondary" onClick={() => setView("home")}>
                ← Назад
              </button>
              <button type="button" className="btn secondary" onClick={onClose}>
                Закрыть
              </button>
            </div>
            <h3>{article.title}</h3>
            <div className="support-article">{article.content}</div>
            {article.relatedRoute ? (
              <button
                type="button"
                className="btn secondary"
                onClick={() => {
                  navigate(article.relatedRoute!);
                  onClose();
                }}
              >
                {article.relatedLabel || "Открыть раздел"}
              </button>
            ) : null}
            {canCreateTicket ? (
              <div className="support-footer">
                <p>Ответ помог?</p>
                <div className="actions">
                  <button
                    type="button"
                    className={`btn ${article.myFeedback === true ? "" : "secondary"}`}
                    onClick={() => {
                      void api.supportArticleFeedback(article.id, true).then(() => setArticle({ ...article, myFeedback: true }));
                    }}
                  >
                    Да
                  </button>
                  <button
                    type="button"
                    className={`btn ${article.myFeedback === false ? "" : "secondary"}`}
                    onClick={() => {
                      void api.supportArticleFeedback(article.id, false).then(() => setArticle({ ...article, myFeedback: false }));
                    }}
                  >
                    Нет
                  </button>
                </div>
                <p className="muted">Не получилось?</p>
                <button type="button" className="btn" disabled={busy} onClick={() => void startChat(`Вопрос: ${article.title}`)}>
                  Написать в поддержку
                </button>
              </div>
            ) : null}
          </>
        ) : null}

        {view === "tickets" ? (
          <>
            <div className="support-head">
              <button type="button" className="btn secondary" onClick={() => setView("home")}>
                ← Назад
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => void startChat()}>
                Новое обращение
              </button>
            </div>
            <b>Мои обращения</b>
            <div className="support-list">
              {tickets.map((item) => (
                <button key={item.id} type="button" className="support-item" onClick={() => void openTicket(item.id)}>
                  <span>
                    #{item.number} — {item.subject}
                  </span>
                  <span className="muted">
                    {item.statusLabel}
                    {item.customerUnread ? ` · ${item.customerUnread}` : ""}
                  </span>
                </button>
              ))}
              {!tickets.length ? <p className="muted">Пока нет обращений.</p> : null}
            </div>
          </>
        ) : null}

        {view === "chat" && chat ? (
          <>
            <div className="support-head">
              <button type="button" className="btn secondary" onClick={() => setView("tickets")}>
                ← Назад
              </button>
              <div>
                <b>Поддержка BasQar</b>
                <p className="muted">
                  #{chat.ticket.number} · {chat.ticket.statusLabel}
                </p>
              </div>
            </div>
            {error ? <p className="error">{error}</p> : null}
            <div className="support-messages" ref={messagesRef}>
              {chat.messages.map((item) => (
                <div
                  key={item.id}
                  className={`support-bubble ${item.senderType === "USER" ? "mine" : item.senderType === "SYSTEM" ? "system" : ""}`}
                >
                  <div>{item.content}</div>
                  {(item.attachments || []).map((file) => (
                    <a
                      key={file.id}
                      className="support-file"
                      href={`/api/v1/support/tickets/${chat.ticket.id}/attachments/${file.id}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {file.kind === "image" ? "Изображение" : file.fileName}
                    </a>
                  ))}
                </div>
              ))}
            </div>
            {chat.ticket.closed ? (
              <p className="muted">Обращение закрыто. Можно создать новое.</p>
            ) : (
              <form
                className="support-composer"
                onSubmit={(event) => {
                  event.preventDefault();
                  void send();
                }}
              >
                <input
                  ref={fileRef}
                  type="file"
                  hidden
                  accept="image/*,.pdf,.doc,.docx,.txt"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void sendFile(file);
                  }}
                />
                <button type="button" className="btn secondary" onClick={() => fileRef.current?.click()} disabled={busy}>
                  +
                </button>
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Напишите сообщение…"
                  disabled={busy}
                />
                <button className="btn" disabled={busy || !draft.trim()}>
                  →
                </button>
              </form>
            )}
          </>
        ) : null}
      </aside>
    </div>
  );
}

export function SupportHelpButton({
  unread,
  onClick,
}: {
  unread: number;
  onClick: () => void;
}) {
  return (
    <button type="button" className="btn secondary support-help-btn" onClick={onClick}>
      Помощь
      {unread > 0 ? <span className="nav-badge">{unread > 9 ? "9+" : unread}</span> : null}
    </button>
  );
}
