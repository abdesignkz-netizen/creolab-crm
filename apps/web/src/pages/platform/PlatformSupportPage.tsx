import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";
import { notifySaved } from "../../components/SaveNotice";
import { useSession } from "../../lib/session";

type Ticket = {
  id: string;
  number: number;
  subject: string;
  status: string;
  statusLabel: string;
  sourceRoute?: string | null;
  sourceLabel?: string | null;
  createdAt: string;
  adminUnread?: number;
  tenantName?: string | null;
  createdBy?: { name: string; email: string } | null;
  assignedTo?: { id: string; name: string } | null;
  closed?: boolean;
  context?: Record<string, unknown>;
};

type Message = {
  id: string;
  senderType: string;
  type: string;
  content: string;
  createdAt: string;
  attachments?: Array<{ id: string; fileName: string; mimeType: string; kind: string }>;
};

type Article = {
  id?: string;
  category: string;
  title: string;
  slug: string;
  content: string;
  keywords: string;
  sortOrder: number;
  isPopular: boolean;
  isPublished?: boolean;
  relatedRoute?: string | null;
  relatedLabel?: string | null;
};

type Reply = {
  id?: string;
  shortcut: string;
  title: string;
  content: string;
  isActive?: boolean;
  sortOrder?: number;
};

const TABS = [
  ["tickets", "Обращения"],
  ["articles", "База знаний"],
  ["replies", "Шаблоны"],
] as const;

const STATUS_FILTERS = [
  ["", "Все"],
  ["OPEN", "Новые"],
  ["IN_PROGRESS", "В работе"],
  ["WAITING_FOR_CUSTOMER", "Ожидают клиента"],
  ["CLOSED", "Закрытые"],
] as const;

const EMPTY_ARTICLE: Article = {
  category: "getting-started",
  title: "",
  slug: "",
  content: "",
  keywords: "",
  sortOrder: 100,
  isPopular: false,
  isPublished: true,
  relatedRoute: "",
  relatedLabel: "",
};

const EMPTY_REPLY: Reply = { shortcut: "/", title: "", content: "", isActive: true, sortOrder: 100 };

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

export function PlatformSupportPage() {
  const { me } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const ticketId = location.pathname.match(/^\/admin\/support\/([^/]+)$/)?.[1] || "";
  const [tab, setTab] = useState<"tickets" | "articles" | "replies">(ticketId ? "tickets" : "tickets");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [chat, setChat] = useState<{ ticket: Ticket; messages: Message[] } | null>(null);
  const [draft, setDraft] = useState("");
  const [replies, setReplies] = useState<Reply[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [categories, setCategories] = useState<Array<{ id: string; title: string }>>([]);
  const [article, setArticle] = useState<Article>(EMPTY_ARTICLE);
  const [reply, setReply] = useState<Reply>(EMPTY_REPLY);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);

  async function loadTickets() {
    const data = (await api.adminSupportTickets({ status, q })) as { items: Ticket[] };
    setTickets(data.items || []);
  }

  async function loadTicket(id: string) {
    const data = (await api.adminSupportTicket(id)) as { ticket: Ticket; messages: Message[] };
    setChat(data);
    await loadTickets();
  }

  async function loadArticles() {
    const data = (await api.adminSupportArticles()) as { items: Article[]; categories: Array<{ id: string; title: string }> };
    setArticles(data.items || []);
    setCategories(data.categories || []);
  }

  async function loadReplies() {
    const data = (await api.adminSupportReplies()) as { items: Reply[] };
    setReplies(data.items || []);
  }

  useEffect(() => {
    void loadTickets().catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
    void loadReplies().catch(() => undefined);
  }, [status]);

  useEffect(() => {
    if (tab === "articles") void loadArticles().catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
    if (tab === "replies") void loadReplies().catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
  }, [tab]);

  useEffect(() => {
    if (ticketId) {
      setTab("tickets");
      void loadTicket(ticketId).catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
    }
  }, [ticketId]);

  useEffect(() => {
    if (tab !== "tickets" || !chat?.ticket.id) return;
    const timer = window.setInterval(() => {
      void api.adminSupportTicket(chat.ticket.id).then((data: any) => setChat(data));
    }, 4000);
    return () => window.clearInterval(timer);
  }, [tab, chat?.ticket.id]);

  useEffect(() => {
    messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight });
  }, [chat?.messages.length]);

  const activeReplies = useMemo(() => replies.filter((item) => item.isActive !== false), [replies]);

  async function send() {
    if (!chat || busy) return;
    const text = draft.trim();
    if (!text) return;
    setBusy(true);
    setError("");
    try {
      const data = (await api.adminSupportMessage(chat.ticket.id, { content: text })) as { ticket: Ticket; messages: Message[] };
      setChat(data);
      setDraft("");
      await loadTickets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не отправлено");
    } finally {
      setBusy(false);
    }
  }

  async function sendFile(file: File) {
    if (!chat) return;
    setBusy(true);
    try {
      const payload = await fileToBase64(file);
      const data = (await api.adminSupportAttachment(chat.ticket.id, payload)) as { ticket: Ticket; messages: Message[] };
      setChat(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Файл не отправлен");
    } finally {
      setBusy(false);
    }
  }

  async function setTicketStatus(next: string) {
    if (!chat) return;
    const data = (await api.adminSupportTicketUpdate(chat.ticket.id, { status: next })) as { ticket: Ticket; messages: Message[] };
    setChat(data);
    await loadTickets();
    notifySaved("Статус обновлён");
  }

  async function assignToMe() {
    if (!chat || !me?.user?.id) return;
    const data = (await api.adminSupportTicketUpdate(chat.ticket.id, { assignedToUserId: me.user.id })) as {
      ticket: Ticket;
      messages: Message[];
    };
    setChat(data);
    notifySaved("Назначено");
  }

  async function saveArticle(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const payload = {
        ...article,
        slug: article.slug || article.title,
        relatedRoute: article.relatedRoute || null,
        relatedLabel: article.relatedLabel || null,
      };
      if (article.id) await api.adminSupportArticleUpdate(article.id, payload);
      else await api.adminSupportArticleCreate(payload);
      await loadArticles();
      setArticle(EMPTY_ARTICLE);
      notifySaved("Статья сохранена");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function saveReply(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (reply.id) await api.adminSupportReplyUpdate(reply.id, reply);
      else await api.adminSupportReplyCreate(reply);
      await loadReplies();
      setReply(EMPTY_REPLY);
      notifySaved("Шаблон сохранён");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div>
        <h2>Поддержка</h2>
        <p className="muted">Обращения пользователей сервиса. Это не CRM-диалоги компаний.</p>
      </div>
      <div className="support-tabs">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" className={`btn ${tab === id ? "" : "secondary"}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {error ? <p className="error">{error}</p> : null}

      {tab === "tickets" ? (
        <div className="support-admin-layout">
          <div className="stack">
            <form
              className="filters"
              onSubmit={(event) => {
                event.preventDefault();
                void loadTickets();
              }}
            >
              <input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Номер или тема" />
              <button className="btn secondary">Найти</button>
            </form>
            <div className="support-tabs">
              {STATUS_FILTERS.map(([id, label]) => (
                <button key={id || "all"} type="button" className={`btn ${status === id ? "" : "secondary"}`} onClick={() => setStatus(id)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="support-list">
              {tickets.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`support-item ${chat?.ticket.id === item.id ? "active" : ""}`}
                  onClick={() => navigate(`/admin/support/${item.id}`)}
                >
                  <b>
                    #{item.number} · {item.tenantName || "Компания"}
                  </b>
                  <span>{item.subject}</span>
                  <span className="muted">
                    {item.statusLabel}
                    {item.adminUnread ? ` · ${item.adminUnread}` : ""}
                  </span>
                </button>
              ))}
              {!tickets.length ? <p className="muted">Обращений нет.</p> : null}
            </div>
          </div>
          <div className="panel stack">
            {!chat ? (
              <p className="muted">Выберите обращение.</p>
            ) : (
              <>
                <div className="support-ticket-meta">
                  <b>
                    #{chat.ticket.number} · {chat.ticket.tenantName || "Компания"}
                  </b>
                  <span>Пользователь: {chat.ticket.createdBy?.name} · {chat.ticket.createdBy?.email}</span>
                  <span>Создано: {formatDateTime(chat.ticket.createdAt)}</span>
                  <span>
                    Раздел: {chat.ticket.sourceLabel || "—"}
                    {chat.ticket.sourceRoute ? ` · ${chat.ticket.sourceRoute}` : ""}
                  </span>
                  <span>Статус: {chat.ticket.statusLabel}</span>
                  <span>Ответственный: {chat.ticket.assignedTo?.name || "не назначен"}</span>
                  {me?.user?.id && chat.ticket.assignedTo?.id !== me.user.id ? (
                    <button type="button" className="btn secondary" onClick={() => void assignToMe()}>
                      Назначить себе
                    </button>
                  ) : null}
                </div>
                <div className="support-messages" ref={messagesRef}>
                  {chat.messages.map((item) => (
                    <div
                      key={item.id}
                      className={`support-bubble ${item.senderType === "ADMIN" ? "mine" : item.senderType === "SYSTEM" ? "system" : ""}`}
                    >
                      <div>{item.content}</div>
                      {(item.attachments || []).map((file) => (
                        <a
                          key={file.id}
                          className="support-file"
                          href={`/api/v1/admin/support/tickets/${chat.ticket.id}/attachments/${file.id}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {file.kind === "image" ? "Изображение" : file.fileName}
                        </a>
                      ))}
                    </div>
                  ))}
                </div>
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
                  <input value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Ответить…" disabled={busy} />
                  <button className="btn" disabled={busy || !draft.trim()}>
                    →
                  </button>
                </form>
                {activeReplies.length ? (
                  <label>
                    Шаблон ответа
                    <select
                      value=""
                      onChange={(event) => {
                        const found = activeReplies.find((item) => item.id === event.target.value);
                        if (found) setDraft(found.content);
                      }}
                    >
                      <option value="">Вставить шаблон…</option>
                      {activeReplies.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.shortcut} — {item.title}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <div className="actions">
                  <button type="button" className="btn secondary" onClick={() => void setTicketStatus("WAITING_FOR_CUSTOMER")}>
                    Ожидаем клиента
                  </button>
                  <button type="button" className="btn secondary" onClick={() => void setTicketStatus("CLOSED")}>
                    Закрыть
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}

      {tab === "articles" ? (
        <div className="support-admin-layout">
          <div className="support-list">
            {articles.map((item) => (
              <button key={item.id} type="button" className="support-item" onClick={() => setArticle(item)}>
                <b>{item.title}</b>
                <span className="muted">
                  {item.category} · {item.isPublished === false ? "скрыта" : "опубликована"}
                  {item.isPopular ? " · популярная" : ""}
                </span>
              </button>
            ))}
            <button type="button" className="btn secondary" onClick={() => setArticle(EMPTY_ARTICLE)}>
              Новая статья
            </button>
          </div>
          <form className="panel stack" onSubmit={(event) => void saveArticle(event)}>
            <label>
              Категория
              <select value={article.category} onChange={(event) => setArticle({ ...article, category: event.target.value })}>
                {categories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Заголовок
              <input value={article.title} onChange={(event) => setArticle({ ...article, title: event.target.value })} />
            </label>
            <label>
              Адрес статьи
              <input value={article.slug} onChange={(event) => setArticle({ ...article, slug: event.target.value })} placeholder="connect-whatsapp" />
            </label>
            <label>
              Текст
              <textarea rows={10} value={article.content} onChange={(event) => setArticle({ ...article, content: event.target.value })} />
            </label>
            <label>
              Ключевые слова
              <input value={article.keywords} onChange={(event) => setArticle({ ...article, keywords: event.target.value })} />
            </label>
            <label>
              Раздел CRM
              <input value={article.relatedRoute || ""} onChange={(event) => setArticle({ ...article, relatedRoute: event.target.value })} placeholder="/integrations" />
            </label>
            <label>
              Подпись кнопки
              <input value={article.relatedLabel || ""} onChange={(event) => setArticle({ ...article, relatedLabel: event.target.value })} />
            </label>
            <label>
              Порядок
              <input type="number" value={article.sortOrder} onChange={(event) => setArticle({ ...article, sortOrder: Number(event.target.value) })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={Boolean(article.isPopular)} onChange={(event) => setArticle({ ...article, isPopular: event.target.checked })} />
              Популярный вопрос
            </label>
            <label className="check">
              <input type="checkbox" checked={article.isPublished !== false} onChange={(event) => setArticle({ ...article, isPublished: event.target.checked })} />
              Опубликована
            </label>
            <div className="actions">
              <button className="btn" disabled={busy}>
                Сохранить
              </button>
              {article.id ? (
                <button
                  type="button"
                  className="btn secondary"
                  onClick={async () => {
                    if (!article.id) return;
                    await api.adminSupportArticleDelete(article.id);
                    setArticle(EMPTY_ARTICLE);
                    await loadArticles();
                    notifySaved("Статья удалена");
                  }}
                >
                  Удалить
                </button>
              ) : null}
            </div>
          </form>
        </div>
      ) : null}

      {tab === "replies" ? (
        <div className="support-admin-layout">
          <div className="support-list">
            {replies.map((item) => (
              <button key={item.id} type="button" className="support-item" onClick={() => setReply(item)}>
                <b>
                  {item.shortcut} — {item.title}
                </b>
                <span className="muted">{item.isActive === false ? "выключен" : "активен"}</span>
              </button>
            ))}
            <button type="button" className="btn secondary" onClick={() => setReply(EMPTY_REPLY)}>
              Новый шаблон
            </button>
          </div>
          <form className="panel stack" onSubmit={(event) => void saveReply(event)}>
            <label>
              Команда
              <input value={reply.shortcut} onChange={(event) => setReply({ ...reply, shortcut: event.target.value })} placeholder="/whatsapp" />
            </label>
            <label>
              Название
              <input value={reply.title} onChange={(event) => setReply({ ...reply, title: event.target.value })} />
            </label>
            <label>
              Текст
              <textarea rows={8} value={reply.content} onChange={(event) => setReply({ ...reply, content: event.target.value })} />
            </label>
            <label>
              Порядок
              <input type="number" value={reply.sortOrder || 100} onChange={(event) => setReply({ ...reply, sortOrder: Number(event.target.value) })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={reply.isActive !== false} onChange={(event) => setReply({ ...reply, isActive: event.target.checked })} />
              Активен
            </label>
            <div className="actions">
              <button className="btn" disabled={busy}>
                Сохранить
              </button>
              {reply.id ? (
                <button
                  type="button"
                  className="btn secondary"
                  onClick={async () => {
                    if (!reply.id) return;
                    await api.adminSupportReplyDelete(reply.id);
                    setReply(EMPTY_REPLY);
                    await loadReplies();
                    notifySaved("Шаблон удалён");
                  }}
                >
                  Удалить
                </button>
              ) : null}
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
