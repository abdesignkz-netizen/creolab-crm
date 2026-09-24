import { ChannelIcon, ConversationAvatar, CONVERSATION_CHANNELS } from "../components/ConversationIdentity";
import { useUrlState, useRequestVersion } from "../lib/useUrlState";
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { nameWithPhone, phoneText } from "../lib/contactDisplay";
import { api } from "../lib/api";
import { tip } from "../lib/tip";
import { dealOutcomeLabel } from "../lib/labels";

const FILTERS = [
  ["all", "Все"],
  ["attention", "Требуют внимания"],
  ["unread", "Непрочитанные"],
  ["needs_reply", "Нужен ответ"],
  ["waiting_client", "Ждём клиента"],
  ["ai", "AI"],
  ["human", "У менеджера"],
  ["today", "Сегодня"],
  ["overdue", "Просроченные"],
  ["no_topic", "Без темы"],
] as const;

type PendingFile = {
  localId: string;
  fileName: string;
  mimeType: string;
  contentBase64: string;
  previewUrl: string;
  kind: "image" | "video" | "audio" | "document";
};

function mediaKind(mimeType: string): PendingFile["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

function readFileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.readAsDataURL(file);
  });
}

async function filesToPending(files: FileList | File[]): Promise<PendingFile[]> {
  const out: PendingFile[] = [];
  for (const file of Array.from(files)) {
    if (file.size > 16 * 1024 * 1024) throw new Error(`«${file.name}» больше 16 МБ`);
    out.push({
      localId: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      contentBase64: await readFileBase64(file),
      previewUrl: URL.createObjectURL(file),
      kind: mediaKind(file.type),
    });
  }
  return out;
}

function MessageBody({ message }: { message: any }) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const type = String(message.type || "text");
  return (
    <>
      {attachments.map((file: any) => (
        <div key={file.id} className="bubble-media">
          {file.kind === "image" ? (
            <a href={file.url} target="_blank" rel="noreferrer">
              <img src={file.url} alt={file.fileName || "Фото"} />
            </a>
          ) : file.kind === "video" ? (
            <video src={file.url} controls preload="metadata" />
          ) : file.kind === "audio" ? (
            <audio src={file.url} controls preload="metadata" />
          ) : (
            <a className="bubble-file" href={file.url} target="_blank" rel="noreferrer">
              {file.fileName || "Файл"}
            </a>
          )}
        </div>
      ))}
      {!attachments.length && type !== "text" ? (
        <div className="bubble-media-placeholder">{message.previewLabel || "Вложение"}</div>
      ) : null}
      {message.text ? <div>{message.text}</div> : null}
    </>
  );
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
  const [channel] = useUrlState("channel", "all", CONVERSATION_CHANNELS.map(([value]) => value));
  const [availableChannels, setAvailableChannels] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<any[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [error, setError] = useState("");
  const [workspace, setWorkspace] = useState<any>(null);
  const [text, setText] = useState("");
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [contextNote, setContextNote] = useState("");
  const [members, setMembers] = useState<Array<{ id: string; name: string; isMe?: boolean }>>([]);
  const [assigneePick, setAssigneePick] = useState("");
  const focusReply = searchParams.get("focus") === "reply";
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const lastVisibleMessageId = workspace?.messages?.at(-1)?.id;
  useLayoutEffect(() => {
    const list = messagesRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [workspace?.conversation?.id, lastVisibleMessageId]);
  const replyRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function loadList() {
    const request = ++listVersion.current;
    setListLoading(true);
    try {
      const data: any = await api.conversations({ filter, q, channel });
      if (request !== listVersion.current) return;
      setItems(data.items || []);
      setAvailableChannels(data.availableChannels || []);
      setError("");
    } catch (err) {
      if (request !== listVersion.current) return;
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      if (request === listVersion.current) setListLoading(false);
    }
  }

  async function loadWorkspace(id: string) {
    if (selectedRef.current !== id) return;
    const request = ++workspaceVersion.current;
    try {
      const data = await api.conversation(id);
      if (request !== workspaceVersion.current) return;
      setWorkspace(data);
      setAssigneePick((data as any).conversation?.assigneeMembershipId || "");
      setItems((previous) => {
        const next = previous.map((item) =>
          item.id === id
            ? {
                ...item,
                unread: false,
                urgent: false,
                needsAttention: false,
                businessStatus: item.businessStatus === "Новая" ? "В работе" : item.businessStatus,
                inquiryStatusLabel: item.inquiryStatusLabel === "Новая" ? "В работе" : item.inquiryStatusLabel,
              }
            : item,
        );
        return filter === "attention" ? next.filter((item) => item.id !== id) : next;
      });
      window.dispatchEvent(new Event("creolab:attention-changed"));
      const messages = (data as any).messages || [];
      const lastMessage = messages[messages.length - 1];
      await api.markConversationRead(id, lastMessage?.id || "");
      if (request !== workspaceVersion.current) return;
      setError("");
    } catch (err) {
      if (request !== workspaceVersion.current) return;
      setError(err instanceof Error ? err.message : "Диалог недоступен");
      setWorkspace(null);
    }
  }

  useEffect(() => {
    // Cancel a pending search when the user changes the channel or status.
    // Otherwise its captured channel could replace the newly selected list.
    const timer = setTimeout(() => loadList(), q ? 250 : 0);
    return () => clearTimeout(timer);
  }, [q, filter, channel]);

  useEffect(() => {
    workspaceVersion.current += 1;
    setWorkspace(null);
    setText("");
    setPendingFiles((previous) => {
      previous.forEach((file) => URL.revokeObjectURL(file.previewUrl));
      return [];
    });
    setShowContext(false);
    setContextNote("");
    setAssigneePick("");
    if (selectedId) loadWorkspace(selectedId);
    else setWorkspace(null);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId || busy || historyLoading) return;
    let live = true;
    let inFlight = false;
    const refresh = async () => {
      if (!live || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      const version = workspaceVersion.current;
      try {
        const data: any = await api.conversation(selectedId);
        if (!live || selectedRef.current !== selectedId || version !== workspaceVersion.current) return;
        setWorkspace((previous: any) => {
          if (previous?.conversation?.id !== selectedId) return previous;
          const firstAt = data.messages?.[0]?.createdAt;
          const earlier = firstAt ? previous.messages.filter((message: any) => message.createdAt < firstAt) : [];
          return { ...data, messages: [...earlier, ...(data.messages || [])],
            hasEarlierMessages: earlier.length ? previous.hasEarlierMessages : data.hasEarlierMessages };
        });
      } catch {
        // A transient background refresh must not erase the conversation or the reply draft.
      } finally { inFlight = false; }
    };
    const timer = window.setInterval(refresh, 5000);
    return () => { live = false; window.clearInterval(timer); };
  }, [selectedId, busy, historyLoading]);

  useEffect(() => {
    if (!focusReply || !workspace) return;
    const node = replyRef.current;
    if (!node) return;
    node.focus();
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusReply, workspace?.conversation?.id]);

  useEffect(() => {
    let live = true;
    void api
      .workspaceMembers()
      .then((data: any) => {
        if (live) setMembers(data.items || []);
      })
      .catch(() => {
        if (live) setMembers([]);
      });
    return () => {
      live = false;
    };
  }, []);

  async function changeMode(action: () => Promise<unknown>) {
    const id = selectedId;
    if (busy || !id) return;
    setBusy(true);
    try { await action(); if (selectedRef.current === id) await loadWorkspace(id); await loadList(); }
    catch (err) { if (selectedRef.current === id) setError(err instanceof Error ? err.message : "Не удалось изменить режим"); }
    finally { setBusy(false); }
  }

  async function addPendingFiles(list: FileList | File[]) {
    if (["email", "instagram"].includes(workspace?.conversation?.channelType)) return;
    try {
      const next = await filesToPending(list);
      setPendingFiles((previous) => {
        const room = Math.max(0, 5 - previous.length);
        const accepted = next.slice(0, room);
        next.slice(room).forEach((file) => URL.revokeObjectURL(file.previewUrl));
        return [...previous, ...accepted];
      });
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось прикрепить файл");
    }
  }

  function removePendingFile(localId: string) {
    setPendingFiles((previous) => {
      const found = previous.find((file) => file.localId === localId);
      if (found) URL.revokeObjectURL(found.previewUrl);
      return previous.filter((file) => file.localId !== localId);
    });
  }

  function onComposerDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    if (workspace?.conversation?.mode !== "human" || busy) return;
    if (event.dataTransfer.files?.length) void addPendingFiles(event.dataTransfer.files);
  }

  const listPane = (
    <div className="conv-list-pane">
      <div className="page-head">
        <h2>Диалоги</h2><span className="badge" title="Диалогов по выбранным условиям">{items.length}</span>
      </div>
      <input
        className="conv-search"
        value={q}
        onChange={(event) => setQ(event.target.value)}
        placeholder="Поиск клиента или сообщения"
        aria-label="Поиск по имени, телефону, компании, теме или сообщению"
      />
      <div className="conv-primary-filters" role="group" aria-label="Статус диалогов">
        {FILTERS.filter(([value]) => ["all", "unread", "needs_reply"].includes(value)).map(([value, label]) => (
          <button key={value} type="button" className={filter === value ? "chip active" : "chip"} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
        ))}
      </div>
      <details className="conv-more-filters">
        <summary>Ещё фильтры{!["all", "unread", "needs_reply"].includes(filter) ? ` · ${FILTERS.find(([value]) => value === filter)?.[1]}` : ""}</summary>
        <div className="chip-row">
          {FILTERS.filter(([value]) => !["all", "unread", "needs_reply"].includes(value)).map(([value, label]) => (
            <button key={value} type="button" className={filter === value ? "chip active" : "chip"} aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>
          ))}
        </div>
      </details>
      {listLoading ? <p className="muted" role="status">Загрузка диалогов…</p> : null}
      {!listLoading && items.length === 0 ? (
        <p className="empty">{q || filter !== "all" || channel !== "all" ? "По выбранным условиям диалоги не найдены." : "Диалоги появятся после подключения каналов. Сейчас можно посмотреть, как устроен этот раздел."}</p>
      ) : null}
      <div className="conv-list">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`conv-row ${selectedId === item.id ? "active" : ""} ${item.unread ? "unread" : ""}`}
            onClick={() => navigate(`/conversations/${item.id}?${searchParams}`)}
          >
            <ConversationAvatar conversationId={item.id} name={item.title} channel={item.channelType || (item.sellerLeadId ? "whatsapp" : "other")} />
            <div className="conv-row-copy">
              <div className="conv-row-top">
                <b>{item.title}</b>
                {item.unread ? <span className="conv-unread-dot" title="Непрочитанные сообщения" aria-label="Непрочитанные сообщения" /> : null}
              </div>
              <div className="conv-preview">{item.lastMessagePreview || "Пока нет сообщений"}</div>
              <div className="conv-row-detail" title={[item.phone, item.topic, item.sourceLine].filter(Boolean).join(" · ")}>
                {item.topic || phoneText(item.phone)}
              </div>
              <div className="conv-meta">
                <span className={item.needsReply ? "conv-reply-badge" : ""}>{item.needsReply ? "Ждёт ответа" : item.businessStatus}</span>
                <span className="badge">{item.modeLabel}</span>
              </div>
              <div className="conv-row-when muted">{item.lastMessageLabel}{item.waitLabel ? ` · ${item.waitLabel}` : ""}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );

  const incomingMail = workspace?.conversation?.channelType === "email";
  const staffOnly = ["telegram", "instagram", "email"].includes(workspace?.conversation?.channelType);
  const canSend = !incomingMail && workspace?.conversation?.channelConnected !== false;
  const canAttach = canSend && workspace?.conversation?.channelType !== "instagram";

  const chatPane = workspace ? (
    <div className="conv-chat-pane">
      <div className="conv-header">
        <div className="conv-person">
          <ConversationAvatar conversationId={workspace.conversation.id} name={workspace.client?.name || "Диалог"} channel={workspace.conversation.channelType || "other"} />
          <div className="conv-person-copy">
          <Link className="btn secondary conversation-back" to={`/conversations?${searchParams}`}>← Диалоги</Link>
          <b>{nameWithPhone(workspace.client?.name || "Диалог", workspace.client?.phone)}</b>
          <div className="muted">
            <span className={`conv-channel-label channel-${workspace.conversation.channelType || "other"}`}><ChannelIcon channel={workspace.conversation.channelType || "other"} />{workspace.conversation.channel}</span>
            {workspace.conversation.channelConnected === false ? " · Канал отключён" : ""}
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
                disabled={busy}
                onClick={() => changeMode(() => api.takeConversation(workspace.conversation.id))}
              >
                Передать менеджеру
              </button>
            ) : !staffOnly ? (
              <button
                className="btn secondary"
                type="button"
                {...tip("Вернуть диалог AI-менеджеру — бот снова отвечает сам")}
                disabled={busy}
                onClick={() => changeMode(() => api.returnToAi(workspace.conversation.id))}
              >
                Вернуть AI
              </button>
            ) : null}
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

      {(workspace.conversation.needsManagerAssign ??
        (workspace.conversation.mode === "human" && !workspace.conversation.assigneeMembershipId)) ? (
        <div className="conv-attention">
          <b>Требуется менеджер</b>
          <div className="muted">{workspace.conversation.attentionReasonLabel || workspace.conversation.attentionReason || "Назначьте ответственного за этот диалог"}</div>
          <div className="conv-attention-assign">
            <select
              aria-label="Менеджер диалога"
              disabled={busy}
              value={assigneePick}
              onChange={(event) => setAssigneePick(event.target.value)}
            >
              <option value="">Выберите менеджера</option>
              {assigneePick && !members.some((member) => member.id === assigneePick) ? (
                <option value={assigneePick}>{workspace.conversation.assigneeName || "Текущий ответственный"}</option>
              ) : null}
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                  {member.isMe ? " · вы" : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn"
              disabled={busy || !assigneePick}
              {...tip("Назначить выбранного сотрудника ответственным за этот диалог")}
              onClick={() =>
                changeMode(() => api.assignConversation(workspace.conversation.id, assigneePick))
              }
            >
              Закрепить менеджера
            </button>
          </div>
        </div>
      ) : null}

      <div className="conv-messages" ref={messagesRef}>
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
            <MessageBody message={message} />
            {message.deliveryLabel ? <div className="muted tiny">{message.deliveryLabel}</div> : null}
          </div>
        ))}
      </div>

      <form
        className="conv-composer"
        onDragOver={(event) => event.preventDefault()}
        onDrop={onComposerDrop}
        onSubmit={async (event) => {
          event.preventDefault();
          if (!text.trim() && !pendingFiles.length) return;
          setBusy(true);
          try {
            await api.sendMessage(
              workspace.conversation.id,
              text.trim(),
              crypto.randomUUID(),
              pendingFiles.map((file) => ({
                fileName: file.fileName,
                mimeType: file.mimeType,
                contentBase64: file.contentBase64,
              })),
            );
            if (selectedRef.current !== workspace.conversation.id) return;
            setText("");
            setPendingFiles((previous) => {
              previous.forEach((file) => URL.revokeObjectURL(file.previewUrl));
              return [];
            });
            await loadWorkspace(workspace.conversation.id);
            await loadList();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Не отправилось");
          } finally {
            setBusy(false);
          }
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          hidden
          multiple
          accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.txt"
          onChange={(event) => {
            if (event.target.files?.length) void addPendingFiles(event.target.files);
            event.target.value = "";
          }}
        />
        {pendingFiles.length ? (
          <div className="conv-pending-files">
            {pendingFiles.map((file) => (
              <div key={file.localId} className="conv-pending-file">
                {file.kind === "image" ? <img src={file.previewUrl} alt="" /> : null}
                {file.kind === "video" ? <video src={file.previewUrl} muted /> : null}
                <span>{file.fileName}</span>
                <button type="button" className="btn secondary" onClick={() => removePendingFile(file.localId)}>
                  Убрать
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          className="btn secondary conv-attach-btn"
          disabled={!canAttach || workspace.conversation.mode !== "human" || busy}
          aria-label="Прикрепить файл"
          {...tip("Прикрепить фото, видео, документ или другой файл")}
          onClick={() => fileInputRef.current?.click()}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <textarea
          ref={replyRef}
          value={text}
          rows={2}
          onChange={(event) => setText(event.target.value)}
          autoFocus={focusReply}
          placeholder={
            incomingMail ? "Входящая почта. Отправляйте ответы из Gmail." : !canSend ? "Канал отключён. Подключите его в настройках интеграций." : workspace.conversation.mode === "human"
              ? "Написать сообщение..."
              : "Сначала передайте диалог менеджеру, затем отвечайте"
          }
          disabled={!canSend || workspace.conversation.mode !== "human" || busy}
        />
        <button
          className="btn"
          disabled={!canSend || workspace.conversation.mode !== "human" || busy || (!text.trim() && !pendingFiles.length)}
          {...tip(
            workspace.conversation.mode !== "human"
              ? "Сначала нажмите «Передать менеджеру» — иначе сообщение не уйдёт"
              : pendingFiles.length
                ? "Отправить сообщение и вложения клиенту"
                : "Отправить сообщение клиенту",
          )}
        >
          Отправить
        </button>
      </form>
    </div>
  ) : (
    <div className="conv-chat-pane empty-pane">
      <div className="conv-welcome">
        <span className="conv-welcome-icon"><ChannelIcon channel="all" /></span>
        <h3>Вся переписка — в одном месте</h3>
        <p className="muted">Выберите диалог, чтобы прочитать сообщения и увидеть данные клиента, заявки и сделки.</p>
      </div>
    </div>
  );

  const contextPane = workspace ? (
    <aside className={`conv-context-pane ${showContext ? "open" : ""}`} aria-label="Информация о клиенте и диалоге">
      <div className="conv-context-identity">
        <ConversationAvatar conversationId={workspace.conversation.id} name={workspace.client?.name || "Клиент"} channel={workspace.conversation.channelType || "other"} />
        <div><b>{workspace.client?.name || "Клиент"}</b><div className="muted">{workspace.client?.companyName || phoneText(workspace.client?.phone)}</div></div>
      </div>
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
          {...tip("Проанализировать переписку и выделить потребность и договорённости")}
          onClick={async () => {
            setBusy(true);
            setError("");
            setContextNote("");
            try {
              const result: any = await api.analyzeConversationContext(workspace.conversation.id);
              if (selectedRef.current !== workspace.conversation.id) return;
              await loadWorkspace(workspace.conversation.id);
              await loadList();
              const analysis = result?.analysis || {};
              const parts = [
                analysis.summaryUpdate,
                analysis.detectedNeed && analysis.summaryUpdate && !String(analysis.summaryUpdate).includes(analysis.detectedNeed)
                  ? `Потребность: ${analysis.detectedNeed}`
                  : null,
                (analysis.agreements || []).length
                  ? `Договорённости: ${analysis.agreements.length}`
                  : null,
              ].filter(Boolean);
              setContextNote(parts.join(" ") || "Контекст разобран, новых фактов нет.");
            } catch (err) {
              setError(err instanceof Error ? err.message : "Не удалось понять контекст");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Разбираем…" : "Понять контекст"}
        </button>
        {contextNote ? <div className="muted" style={{ marginTop: 8 }}>{contextNote}</div> : null}
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
        <p>{workspace.conversation.contextSummary || workspace.client?.summary}</p>
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
            <summary className="muted">Откуда пришёл</summary>
            <div className="muted">Кампания: {workspace.attribution.utmCampaign}</div>
            {workspace.attribution.landingPage ? <div className="muted">Страница: {workspace.attribution.landingPage}</div> : null}
          </details>
        ) : null}
      </div>

      {workspace.deal ? (
        <div className="panel soft">
          <b>Сделка</b>
          <div>{workspace.deal.title}</div>
          <div className="muted">
            {dealOutcomeLabel(workspace.deal.outcome, workspace.deal.stage)}
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
      {error ? <p className="error" style={{ gridColumn: "1 / -1" }} role="alert">{error}</p> : null}
      <nav className="conversation-channels" aria-label="Каналы диалогов">
        {CONVERSATION_CHANNELS.filter(([value]) => value === "all" || value === channel || availableChannels.includes(value)).map(([value, label]) => (
          <button key={value} type="button" className={`conversation-channel channel-${value}${channel === value ? " active" : ""}`} aria-pressed={channel === value} aria-label={`${label}: диалоги`} onClick={() => {
            const next = new URLSearchParams(searchParams);
            if (value === "all") next.delete("channel"); else next.set("channel", value);
            next.delete("focus");
            navigate(`/conversations?${next}`);
          }}>
            <ChannelIcon channel={value} /><span>{label}</span>
          </button>
        ))}
      </nav>
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
