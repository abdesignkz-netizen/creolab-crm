import { useUrlState, useRequestVersion } from "../lib/useUrlState";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { nameWithPhone, phoneText } from "../lib/contactDisplay";
import { api } from "../lib/api";
import { tip } from "../lib/tip";

const FILTERS = [
  ["all", "Все"],
  ["unread", "Непрочитанные"],
  ["needs_reply", "Нужен ответ"],
  ["waiting_client", "Ждём клиента"],
  ["ai", "AI"],
  ["human", "У менеджера"],
  ["today", "Сегодня"],
  ["overdue", "Просроченные"],
  ["no_topic", "Без темы"],
] as const;

function relativeLabel(minutes: number | null | undefined) {
  if (minutes == null) return null;
  if (minutes < 60) return `${minutes} мин назад`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)} ч назад`;
  return `${Math.floor(minutes / (60 * 24))} дн назад`;
}

export function ConversationsPage() {
  const listVersion = useRequestVersion();
  const workspaceVersion = useRequestVersion();
  const navigate = useNavigate();
  const { id: selectedId } = useParams();
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const [historyLoading, setHistoryLoading] = useState(false);
  const [searchParams] = useSearchParams();
  const [filter, setFilter] = useUrlState("filter", "all", FILTERS.map(([value]) => value));
  const [q, setQ] = useState("");
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState<any>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const focusReply = searchParams.get("focus") === "reply";
  const replyRef = useRef<HTMLTextAreaElement | null>(null);

  async function loadList() {
    const request = ++listVersion.current;
    try {
      const data: any = await api.conversations({ filter, q });
      if (request !== listVersion.current) return;
      setItems(data.items || []);
      setError("");
    } catch (err) {
      if (request !== listVersion.current) return;
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  async function loadWorkspace(id: string) {
    if (selectedRef.current !== id) return;
    const request = ++workspaceVersion.current;
    try {
      const data = await api.conversation(id);
      if (request !== workspaceVersion.current) return;
      setWorkspace(data);
      const messages = (data as any).messages || [];
      const lastMessage = messages[messages.length - 1];
      if (lastMessage) {
        await api.markConversationRead(id, lastMessage.id);
        if (request !== workspaceVersion.current) return;
        setItems(previous => previous.map(item => item.id === id ? { ...item, unread: false } : item));
      }
      setError("");
    } catch (err) {
      if (request !== workspaceVersion.current) return;
      setError(err instanceof Error ? err.message : "Диалог недоступен");
      setWorkspace(null);
    }
  }

  useEffect(() => {
    loadList();
  }, [filter]);

  useEffect(() => {
    const timer = setTimeout(() => loadList(), 250);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    workspaceVersion.current += 1;
    setWorkspace(null);
    setText("");
    if (selectedId) loadWorkspace(selectedId);
    else setWorkspace(null);
  }, [selectedId]);

  useEffect(() => {
    if (!focusReply || !workspace) return;
    const node = replyRef.current;
    if (!node) return;
    node.focus();
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusReply, workspace?.conversation?.id]);

  const listPane = (
    <div className="conv-list-pane">
      <div className="page-head">
        <h2>Диалоги</h2>
      </div>
      <input
        className="conv-search"
        value={q}
        onChange={(event) => setQ(event.target.value)}
        placeholder="Имя, телефон, компания, тема или сообщение"
      />
      <div className="chip-row">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={filter === value ? "chip active" : "chip"}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {items.length === 0 ? (
        <p className="empty">Пока нет диалогов. Новые обращения из подключённых каналов появятся здесь автоматически.</p>
      ) : null}
      <div className="conv-list">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`conv-row ${selectedId === item.id ? "active" : ""} ${item.unread ? "unread" : ""}`}
            onClick={() => navigate(`/conversations/${item.id}`)}
          >
            <div className="conv-row-top">
              <b>{item.title}</b>
              <span className="muted">{item.lastMessageLabel?.split(", ").pop() || item.lastMessageLabel}</span>
            </div>
            <div className="muted">{phoneText(item.phone)}</div>
            <div className="conv-topic">{item.topic}</div>
            <div className="muted">{item.sourceLine}</div>
            <div className="conv-preview">«{item.lastMessagePreview}»</div>
            <div className="conv-meta">
              <span>
                {[item.businessStatus, item.needsReply ? "Нужен ответ" : null, item.waitLabel]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <span className="badge">{item.modeLabel}</span>
            </div>
            {item.urgent ? <span className="urgent-dot" title="Срочно" /> : null}
          </button>
        ))}
      </div>
    </div>
  );

  const chatPane = workspace ? (
    <div className="conv-chat-pane">
      <div className="conv-header">
        <div>
          <b>{nameWithPhone(workspace.client?.name || "Диалог", workspace.client?.phone)}</b>
          <div className="muted">
            {[phoneText(workspace.client?.phone), workspace.conversation.sourceLine].filter(Boolean).join(" · ")}
          </div>
          <div className="conv-topic">{workspace.conversation.topic}</div>
          {workspace.currentRequest ? (
            <div className="muted">
              Заявка:{" "}
              <Link to={`/requests/${workspace.currentRequest.id}`}>
                {workspace.currentRequest.title} · {workspace.currentRequest.statusLabel}
              </Link>
            </div>
          ) : (
            <div className="muted">Заявка не определена</div>
          )}
        </div>
        <div className="conv-header-actions">
          <span className="badge">{workspace.conversation.modeLabel}</span>
          <div className="muted">Ответственный: {workspace.conversation.assigneeName || "Не назначен"}</div>
          <div className="actions">
            {workspace.client?.id ? (
              <Link
                className="btn secondary"
                to={`/contacts/${workspace.client.id}`}
                {...tip("Открыть карточку клиента 360°")}
              >
                Карточка клиента
              </Link>
            ) : null}
            <button
              type="button"
              className="btn secondary mobile-only"
              {...tip("Заявка, сделка и договорённости по диалогу")}
              onClick={() => setShowContext(true)}
            >
              Информация
            </button>
            {workspace.conversation.mode !== "human" ? (
              <button
                className="btn"
                type="button"
                {...tip("AI перестанет отвечать — диалог забираете вы")}
                onClick={() => api.takeConversation(workspace.conversation.id).then(() => loadWorkspace(workspace.conversation.id)).then(loadList)}
              >
                Передать менеджеру
              </button>
            ) : (
              <button
                className="btn secondary"
                type="button"
                {...tip("Вернуть диалог AI Manager — бот снова отвечает сам")}
                onClick={() => api.returnToAi(workspace.conversation.id).then(() => loadWorkspace(workspace.conversation.id)).then(loadList)}
              >
                Вернуть AI
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="conv-context-strip">
        <span>Первое обращение: {workspace.client?.firstContactLabel || "—"}</span>
        <span>Последнее: {workspace.conversation.lastMessageLabel || "—"}</span>
        <span>Последним написал: {workspace.conversation.lastWriterLabel}</span>
        {workspace.conversation.needsReply ? (
          <span className="warn-text">{workspace.conversation.waitLabel || "Нужен ответ"}</span>
        ) : (
          <span>Ждём клиента</span>
        )}
      </div>

      {workspace.conversation.attentionReason && workspace.conversation.mode === "human" ? (
        <div className="panel soft">
          <b>Требуется менеджер</b>
          <div className="muted">{workspace.conversation.attentionReason}</div>
        </div>
      ) : null}

      <div className="conv-messages">
        {workspace.hasEarlierMessages ? <button type="button" className="btn secondary history-button" disabled={historyLoading} onClick={async () => {
          const id = workspace.conversation.id;
          setHistoryLoading(true);
          try {
            const page: any = await api.conversationMessages(id, workspace.messages[0].id);
            if (selectedRef.current !== id) return;
            setWorkspace((previous: any) => ({ ...previous, messages: [...page.messages, ...previous.messages], hasEarlierMessages: page.hasEarlierMessages }));
          } catch (err) { if (selectedRef.current === id) setError(err instanceof Error ? err.message : "Не удалось загрузить историю"); }
          finally { setHistoryLoading(false); }
        }}>{historyLoading ? "Загрузка…" : "Показать более ранние сообщения"}</button> : null}
        {workspace.messages.map((message: any) => (
          <div
            key={message.id}
            className={`bubble ${message.direction === "inbound" || message.senderKind === "client" ? "in" : "out"}`}
          >
            <div className="bubble-meta">
              <span>{message.actorLabel}</span>
              <span>{message.createdLabel}</span>
            </div>
            <div>{message.text}</div>
            {message.deliveryLabel ? <div className="muted tiny">{message.deliveryLabel}</div> : null}
          </div>
        ))}
      </div>

      <form
        className="conv-composer"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!text.trim()) return;
          setBusy(true);
          try {
            await api.sendMessage(workspace.conversation.id, text.trim(), crypto.randomUUID());
            if (selectedRef.current !== workspace.conversation.id) return;
            setText("");
            await loadWorkspace(workspace.conversation.id);
            await loadList();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Не отправилось");
          } finally {
            setBusy(false);
          }
        }}
      >
        <textarea
          ref={replyRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          autoFocus={focusReply}
          placeholder={
            workspace.conversation.mode === "human"
              ? "Написать сообщение..."
              : "Сначала передайте диалог менеджеру, затем отвечайте"
          }
          disabled={workspace.conversation.mode !== "human" || busy}
        />
        <button
          className="btn"
          disabled={workspace.conversation.mode !== "human" || busy}
          {...tip(
            workspace.conversation.mode !== "human"
              ? "Сначала нажмите «Передать менеджеру» — иначе сообщение не уйдёт"
              : "Отправить сообщение клиенту в WhatsApp",
          )}
        >
          Отправить
        </button>
      </form>
    </div>
  ) : (
    <div className="conv-chat-pane empty-pane">
      <p className="muted">Выберите диалог слева</p>
    </div>
  );

  const contextPane = workspace ? (
    <aside className={`conv-context-pane ${showContext ? "open" : ""}`}>
      <div className="page-head mobile-only">
        <b>Контекст</b>
        <button type="button" className="btn secondary" onClick={() => setShowContext(false)}>
          Закрыть
        </button>
      </div>

      <div className="panel soft">
        <b>Сейчас</b>
        <div>{workspace.control.situationLabel}</div>
        <div className="muted">{workspace.control.waitLabel}</div>
        {workspace.conversation.waitingForLabel ? (
          <div className="muted">{workspace.conversation.waitingForLabel}</div>
        ) : null}
        {workspace.deal ? (
          <div className="muted">
            Сделка: {workspace.deal.title}
            {workspace.deal.stage ? ` · ${workspace.deal.stage}` : ""}
          </div>
        ) : null}
        {workspace.control.nextAction ? (
          <div>
            Следующее действие: {workspace.control.nextAction.title}
            {workspace.control.nextAction.dueLabel ? ` · ${workspace.control.nextAction.dueLabel}` : ""}
          </div>
        ) : (
          <div className="muted">Нет следующего действия</div>
        )}
        {workspace.control.overdue ? <div className="warn-text">Просрочено: {workspace.control.overdueTitle}</div> : null}
        <button
          type="button"
          className="btn secondary"
          style={{ marginTop: 8 }}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api
              .analyzeConversationContext(workspace.conversation.id)
              .then(() => loadWorkspace(workspace.conversation.id))
              .then(loadList)
              .catch((err: Error) => setError(err.message))
              .finally(() => setBusy(false));
          }}
        >
          Понять контекст
        </button>
      </div>

      {(workspace.agreements || []).length ? (
        <div className="panel soft">
          <b>Договорённости</b>
          {workspace.agreements.map((agr: any) => (
            <div key={agr.id} style={{ marginTop: 8 }}>
              <div>
                <b>{agr.typeLabel}</b>
                <span className="muted"> · {agr.confidenceUserLabel || agr.statusLabel}</span>
              </div>
              <div className="muted">{agr.scheduledLabel || agr.title}</div>
              {agr.meetingProvider ? <div className="muted">{agr.meetingProvider}</div> : null}
              {agr.meetingUrl ? (
                <a href={agr.meetingUrl} target="_blank" rel="noreferrer">
                  Открыть встречу
                </a>
              ) : agr.type === "ONLINE_MEETING" ? (
                <div className="warn-text">Ссылка на встречу не добавлена</div>
              ) : null}
              {agr.locationName || agr.address ? (
                <div className="muted">
                  {[agr.locationName, agr.address].filter(Boolean).join(" · ")}
                </div>
              ) : null}
              {agr.clarificationNeeded ? <div className="warn-text">{agr.clarificationNeeded}</div> : null}
              {agr.taskId ? (
                <Link to={`/tasks?open=${agr.taskId}`}>Открыть задачу</Link>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      <div className="panel soft">
        <b>Кратко</b>
        <p>{workspace.client?.summary}</p>
      </div>

      <div className="panel soft">
        <b>Клиент</b>
        <div>{workspace.client?.name}</div>
        <div className="muted">{phoneText(workspace.client?.phone)}</div>
        {workspace.client?.companyName ? <div className="muted">{workspace.client.companyName}</div> : null}
        {workspace.client?.id ? <Link to={`/contacts/${workspace.client.id}`}>Открыть карточку</Link> : null}
      </div>

      <div className="panel soft">
        <b>Интерес / заявка</b>
        <div>{workspace.conversation.topic}</div>
        {workspace.currentRequest ? (
          <>
            <div>
              <Link to={`/requests/${workspace.currentRequest.id}`}>{workspace.currentRequest.title || workspace.conversation.topic}</Link>
            </div>
            <div className="muted">{workspace.currentRequest.statusLabel}</div>
            {workspace.currentRequest.budgetLabel ? <div className="muted">Бюджет: {workspace.currentRequest.budgetLabel}</div> : null}
            {workspace.currentRequest.desiredDeadline ? <div className="muted">Срок: {workspace.currentRequest.desiredDeadline}</div> : null}
          </>
        ) : (
          <div className="muted">Заявка не определена</div>
        )}
      </div>

      <div className="panel soft">
        <b>Источник</b>
        <div>{workspace.conversation.sourceLine}</div>
        {workspace.attribution.utmCampaign ? (
          <details>
            <summary className="muted">Детали UTM</summary>
            <div className="muted">Campaign: {workspace.attribution.utmCampaign}</div>
            {workspace.attribution.landingPage ? <div className="muted">Landing: {workspace.attribution.landingPage}</div> : null}
          </details>
        ) : null}
      </div>

      {workspace.deal ? (
        <div className="panel soft">
          <b>Сделка</b>
          <div>{workspace.deal.title}</div>
          <div className="muted">
            {workspace.deal.stage || workspace.deal.outcome}
            {workspace.deal.amountMinor != null ? ` · ${Number(workspace.deal.amountMinor).toLocaleString("ru-RU")} ${workspace.deal.currency || "KZT"}` : ""}
          </div>
        </div>
      ) : null}

      <div className="panel soft">
        <b>Определено из разговора</b>
        <div className="muted">Услуга: {workspace.extracted.service || "не указана"}</div>
        <div className="muted">Бюджет: {workspace.extracted.budget || "не определён"}</div>
        <div className="muted">Срок: {workspace.extracted.deadline || "не указан"}</div>
        <div className="muted">Компания: {workspace.extracted.company || "не указана"}</div>
        <div className="muted">Город: {workspace.extracted.city || "не указан"}</div>
      </div>

      <div className="actions">
        <Link
          className="btn secondary"
          to={`/tasks?conversationId=${workspace.conversation.id}${workspace.client?.id ? `&contactId=${workspace.client.id}` : ""}${workspace.deal?.id ? `&dealId=${workspace.deal.id}` : ""}`}
          {...tip("Создать задачу по этому диалогу с уже выбранным клиентом")}
        >
          Создать задачу
        </Link>
      </div>
    </aside>
  ) : (
    <aside className="conv-context-pane desktop-only" />
  );

  return (
    <section className={`conversations-layout ${selectedId ? "has-selection" : ""}`}>
      {error ? <p className="error">{error}</p> : null}
      {listPane}
      {chatPane}
      {contextPane}
      {showContext ? <div className="conv-backdrop mobile-only" onClick={() => setShowContext(false)} /> : null}
    </section>
  );
}

/** Combined route: /conversations and /conversations/:id use same layout */
export function ConversationsRoute() {
  return <ConversationsPage />;
}
