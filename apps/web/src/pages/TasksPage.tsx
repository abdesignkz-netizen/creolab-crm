import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { CampaignMassPanel } from "./CampaignMassPanel";

type Filter = "open" | "waiting" | "overdue" | "mine" | "all";
type TargetMode = "client" | "group" | "none";

type PickerClient = {
  id: string;
  name: string;
  phone: string | null;
  companyName?: string | null;
  interest?: string | null;
  statusLabel?: string | null;
  source?: string | null;
  lastContactLabel?: string | null;
  inquiryId?: string | null;
  dealId?: string | null;
  conversationId?: string | null;
};

const GROUP_TITLE: Record<string, string> = {
  overdue: "Просрочено",
  today: "Сегодня",
  later: "Позже",
  none: "Без срока",
};

const TASK_TYPES = [
  ["call", "Позвонить"],
  ["message", "Написать"],
  ["follow_up", "Напомнить"],
  ["meeting", "Встреча"],
  ["proposal", "Отправить КП"],
  ["send_documents", "Отправить документы"],
  ["prepare_estimate", "Подготовить расчёт"],
  ["wait_client", "Ждать клиента"],
  ["payment", "Проверить оплату"],
  ["process_inquiry", "Обработать обращение"],
  ["other", "Другое"],
] as const;

const QUICK_SEGMENTS = [
  { id: "today", label: "Все новые сегодня", body: { datePreset: "today", dateField: "lastContact" } },
  { id: "yesterday", label: "Все новые вчера", body: { datePreset: "yesterday", dateField: "lastContact" } },
  { id: "week", label: "За 7 дней", body: { datePreset: "last_7_days" } },
  { id: "web", label: "Интересовались сайтами", body: { serviceCategories: ["WEB"] } },
  { id: "pres", label: "Презентации", body: { serviceCategories: ["PRESENTATION"] } },
  { id: "ads", label: "Реклама", body: { serviceCategories: ["ADVERTISING"] } },
  { id: "reply", label: "Ждут ответа", body: { needsReply: true } },
  { id: "next", label: "Нет следующего действия", body: { missingNextAction: true } },
  { id: "hot", label: "Горячие", body: { hot: true } },
  { id: "overdue", label: "Просроченная задача", body: { hasOverdueTask: true } },
] as const;

const SERVICE_OPTIONS = [
  { id: "WEB", label: "Разработка сайта" },
  { id: "PRESENTATION", label: "Презентация" },
  { id: "ADVERTISING", label: "Реклама" },
  { id: "BRANDING", label: "Брендинг" },
  { id: "AI", label: "AI Manager" },
];

const STATUS_OPTIONS = [
  { id: "new", label: "Новый" },
  { id: "qualification", label: "Квалификация" },
  { id: "accepted", label: "В работе" },
  { id: "in_progress", label: "В работе" },
  { id: "waiting_client", label: "Ждём клиента" },
  { id: "waiting_manager", label: "Нужен ответ" },
  { id: "closed", label: "Закрыт" },
  { id: "lost", label: "Потерян" },
];

const SOURCE_OPTIONS = [
  { id: "whatsapp", label: "WhatsApp" },
  { id: "form", label: "Сайт" },
  { id: "instagram", label: "Instagram" },
  { id: "telegram", label: "Telegram" },
  { id: "manual", label: "Вручную" },
];

function dueGroup(item: any, now: Date) {
  if (!item.dueAt) return "none";
  const due = new Date(item.dueAt);
  if (due.getTime() < now.getTime() && item.status !== "done" && item.status !== "canceled") return "overdue";
  if (due.toDateString() === now.toDateString()) return "today";
  return "later";
}

function suggestedTitle(type: string, mode: TargetMode, client?: PickerClient | null, groupCount?: number, segmentLabel?: string) {
  const typeLabel = TASK_TYPES.find(([id]) => id === type)?.[1] || "Задача";
  if (mode === "client" && client) {
    return `${typeLabel} — ${client.name}${client.interest ? ` / ${client.interest}` : ""}`;
  }
  if (mode === "group") {
    return `${typeLabel} — ${segmentLabel || "группа"}${groupCount ? ` / ${groupCount} клиентов` : ""}`;
  }
  return typeLabel;
}

function toggleValue(list: string[], value: string) {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function TasksPage() {
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("open");
  const [me, setMe] = useState<any>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(true);
  const [messageDraft, setMessageDraft] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [execResult, setExecResult] = useState<any>(null);
  const [nextPanel, setNextPanel] = useState<{ taskId: string; actions: any[] } | null>(null);
  const [completeOpen, setCompleteOpen] = useState<string | null>(null);
  const [resultCode, setResultCode] = useState("reached");
  const [docType, setDocType] = useState("proposal");
  const [busy, setBusy] = useState(false);

  const SENDABLE = new Set(["proposal", "message", "send_documents", "prepare_estimate", "follow_up"]);
  const MANUAL_COMPLETE = new Set(["call", "meeting", "payment", "wait_client", "process_inquiry", "other"]);

  const [targetMode, setTargetMode] = useState<TargetMode>("client");
  const [type, setType] = useState("call");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [priority, setPriority] = useState("normal");
  const [ownerId, setOwnerId] = useState("");

  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<PickerClient[]>([]);
  const [selectedClient, setSelectedClient] = useState<PickerClient | null>(null);
  const [overview, setOverview] = useState<any>(null);
  const [inquiryId, setInquiryId] = useState("");
  const [dealId, setDealId] = useState("");
  const [conversationId, setConversationId] = useState("");

  const [serviceCategories, setServiceCategories] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [datePreset, setDatePreset] = useState("");
  const [segmentLabel, setSegmentLabel] = useState("");
  const [segmentClients, setSegmentClients] = useState<PickerClient[]>([]);
  const [segmentTotal, setSegmentTotal] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [composeMode, setComposeMode] = useState<"command" | "manual" | "campaign">("command");
  const [commandText, setCommandText] = useState("");
  const [commandParse, setCommandParse] = useState<any>(null);
  const [commandSelectedIds, setCommandSelectedIds] = useState<string[]>([]);
  const [commandDraft, setCommandDraft] = useState("");
  const [commandTaskId, setCommandTaskId] = useState<string | null>(null);
  const [batchResult, setBatchResult] = useState<any>(null);
  const [cmdWhoMode, setCmdWhoMode] = useState<"auto" | "contact" | "phone" | "list" | "group" | "import">("contact");
  const [cmdSearchQ, setCmdSearchQ] = useState("");
  const [cmdSearchHits, setCmdSearchHits] = useState<PickerClient[]>([]);
  const [cmdSelectedContacts, setCmdSelectedContacts] = useState<PickerClient[]>([]);
  const [cmdPhoneDraft, setCmdPhoneDraft] = useState("");
  const [cmdPhoneNameDraft, setCmdPhoneNameDraft] = useState("");
  const [cmdPhones, setCmdPhones] = useState<Array<{ phone: string; name: string }>>([]);
  const [cmdPhonesUnresolved, setCmdPhonesUnresolved] = useState<string[]>([]);
  const [showCampaignPanel, setShowCampaignPanel] = useState(false);
  const [campaignSeed, setCampaignSeed] = useState<{
    phones?: string;
    contactIds?: string[];
    segment?: Record<string, unknown>;
    message?: string;
    command?: string;
    whoMode?: "contacts" | "phones" | "segment" | "import";
  }>({});

  async function load() {
    try {
      const [data, profile, memberData] = await Promise.all([api.tasks(), api.me(), api.workspaceMembers()]);
      setItems((data as { items: any[] }).items);
      setMe(profile);
      setMembers((memberData as { items: any[] }).items);
      const mid = (profile as any)?.activeTenant?.membershipId || (memberData as { items: any[] }).items.find((m) => m.isMe)?.id;
      if (mid && !ownerId) setOwnerId(mid);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    if (!searchQ.trim() || selectedClient) {
      setSearchHits([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchContacts(searchQ.trim())
        .then((data: any) => setSearchHits(data.clients || []))
        .catch(() => setSearchHits([]));
    }, 220);
    return () => clearTimeout(timer);
  }, [searchQ, selectedClient]);

  useEffect(() => {
    if (cmdWhoMode !== "contact" || !cmdSearchQ.trim()) {
      setCmdSearchHits([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchContacts(cmdSearchQ.trim())
        .then((data: any) => setCmdSearchHits(data.clients || []))
        .catch(() => setCmdSearchHits([]));
    }, 220);
    return () => clearTimeout(timer);
  }, [cmdSearchQ, cmdWhoMode]);

  useEffect(() => {
    if (!selectedClient) {
      setOverview(null);
      return;
    }
    api
      .contactOverview(selectedClient.id)
      .then((data: any) => {
        setOverview(data);
        const requests = data.requests || [];
        const active = requests.find((item: any) => !item.closed) || requests[0];
        setInquiryId(active?.id || "");
        setDealId(data.deals?.[0]?.id || "");
        setConversationId(data.conversations?.[0]?.id || "");
        if (!title.trim()) setTitle(suggestedTitle(type, "client", selectedClient));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Не удалось загрузить клиента"));
  }, [selectedClient?.id]);

  const segmentBody = useMemo(
    () => ({
      serviceCategories: serviceCategories.length ? serviceCategories : undefined,
      statuses: statuses.length ? statuses : undefined,
      sources: sources.length ? sources : undefined,
      datePreset: datePreset || undefined,
      dateField: "lastContact" as const,
      limit: 80,
    }),
    [serviceCategories, statuses, sources, datePreset],
  );

  async function runPreview(extra: Record<string, unknown> = {}, label = "") {
    setPreviewBusy(true);
    try {
      const data: any = await api.segmentPreview({ ...segmentBody, ...extra });
      setSegmentClients(data.clients || []);
      setSegmentTotal(data.total || 0);
      setSelectedIds((data.clients || []).map((item: PickerClient) => item.id));
      if (label) setSegmentLabel(label);
      else if (!segmentLabel) setSegmentLabel(buildSegmentLabel(extra));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось построить выборку");
    } finally {
      setPreviewBusy(false);
    }
  }

  function buildSegmentLabel(extra: Record<string, unknown> = {}) {
    const parts: string[] = [];
    const cats = (extra.serviceCategories as string[]) || serviceCategories;
    const dates = (extra.datePreset as string) || datePreset;
    if (cats.includes("WEB")) parts.push("Сайты");
    if (cats.includes("PRESENTATION")) parts.push("Презентации");
    if (cats.includes("ADVERTISING")) parts.push("Реклама");
    if (dates === "today") parts.push("сегодня");
    if (dates === "yesterday") parts.push("вчера");
    if (extra.needsReply) parts.push("ждут ответа");
    if (extra.missingNextAction) parts.push("без следующего шага");
    if (extra.hot) parts.push("горячие");
    return parts.join(" · ") || "Выборка";
  }

  const membershipId = me?.activeTenant?.membershipId;
  const now = new Date();
  const visible = items.filter((item) => {
    if (filter === "all") return true;
    if (filter === "waiting") return item.status === "waiting";
    if (filter === "overdue") {
      return item.dueAt && new Date(item.dueAt) < now && item.status !== "done" && item.status !== "canceled";
    }
    if (filter === "mine") return item.ownerMembershipId === membershipId && item.status !== "done";
    return item.status === "open";
  });

  const groups = ["overdue", "today", "later", "none"].map((key) => ({
    key,
    items: visible.filter((item) => dueGroup(item, now) === key),
  }));

  async function submitTask(event: FormEvent) {
    event.preventDefault();
    try {
      if (targetMode === "client" && !selectedClient) {
        setError("Выберите клиента");
        return;
      }
      if (targetMode === "group" && selectedIds.length === 0) {
        setError("Выберите хотя бы одного клиента");
        return;
      }
      if (targetMode === "group" && selectedIds.length >= 100) {
        const ok = window.confirm(`Задача будет создана для ${selectedIds.length} клиентов. Продолжить?`);
        if (!ok) return;
      }

      const finalTitle =
        title.trim() ||
        suggestedTitle(type, targetMode, selectedClient, selectedIds.length, segmentLabel);

      await api.createTask({
        type,
        title: finalTitle,
        description: description || undefined,
        dueAt: dueAt ? new Date(dueAt).toISOString() : undefined,
        priority,
        ownerMembershipId: ownerId || undefined,
        targetType: targetMode,
        contactId: targetMode === "client" ? selectedClient?.id : undefined,
        inquiryId: targetMode === "client" && inquiryId ? inquiryId : undefined,
        dealId: targetMode === "client" && dealId ? dealId : undefined,
        conversationId: targetMode === "client" && conversationId ? conversationId : undefined,
        clientIds: targetMode === "group" ? selectedIds : undefined,
        segmentSnapshot:
          targetMode === "group"
            ? {
                label: segmentLabel || buildSegmentLabel(),
                ...segmentBody,
                selectedCount: selectedIds.length,
                totalMatched: segmentTotal,
              }
            : undefined,
      }).then(async (created: any) => {
        if (SENDABLE.has(type) && created?.id && messageDraft.trim()) {
          await api.updateTask(created.id, { messageDraft: messageDraft.trim() });
        }
        if (SENDABLE.has(type) && created?.id && targetMode === "client") {
          setActiveTaskId(created.id);
          const detail = await api.task(created.id);
          setTaskDetail(detail);
        }
        return created;
      });

      setTitle("");
      setDescription("");
      setMessageDraft("");
      setDueAt("");
      setSelectedClient(null);
      setSearchQ("");
      setOverview(null);
      setSegmentClients([]);
      setSelectedIds([]);
      setSegmentTotal(0);
      setShowCreate(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать");
    }
  }

  async function openTaskEditor(taskId: string) {
    setBusy(true);
    setError("");
    setPreview(null);
    setExecResult(null);
    try {
      const detail = await api.task(taskId);
      setActiveTaskId(taskId);
      setTaskDetail(detail);
      setMessageDraft((detail as any).messageDraft || (detail as any).description || "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось открыть задачу");
    } finally {
      setBusy(false);
    }
  }

  async function onAttachFile(file: File) {
    if (!activeTaskId) return;
    setBusy(true);
    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      bytes.forEach((b) => {
        binary += String.fromCharCode(b);
      });
      const contentBase64 = btoa(binary);
      await api.addTaskAttachment(activeTaskId, {
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        contentBase64,
        documentType: docType,
      });
      const detail = await api.task(activeTaskId);
      setTaskDetail(detail);
      setPreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось прикрепить файл");
    } finally {
      setBusy(false);
    }
  }

  async function onPrepare() {
    if (!activeTaskId) return;
    setBusy(true);
    try {
      await api.updateTask(activeTaskId, { messageDraft });
      const data = await api.prepareTaskExecution(activeTaskId);
      setPreview(data);
      setExecResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось подготовить");
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmAndSend() {
    if (!activeTaskId) return;
    setBusy(true);
    try {
      await api.confirmTaskExecution(activeTaskId);
      const result = await api.executeTask(activeTaskId);
      setExecResult(result);
      if ((result as any).success) {
        setNextPanel({ taskId: activeTaskId, actions: (result as any).nextActions || [] });
        setPreview(null);
        setActiveTaskId(null);
        setTaskDetail(null);
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Отправка не удалась");
    } finally {
      setBusy(false);
    }
  }

  async function onRetryFiles() {
    if (!activeTaskId) return;
    setBusy(true);
    try {
      const result = await api.executeTask(activeTaskId, { retryFailedFilesOnly: true });
      setExecResult(result);
      if ((result as any).success) {
        setNextPanel({ taskId: activeTaskId, actions: (result as any).nextActions || [] });
        setActiveTaskId(null);
        setPreview(null);
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Повтор не удался");
    } finally {
      setBusy(false);
    }
  }

  function addCmdPhone() {
    const phone = cmdPhoneDraft.trim();
    if (phone.length < 5) {
      setError("Укажите телефон полностью");
      return;
    }
    if (cmdPhones.some((item) => item.phone === phone)) {
      setError("Этот номер уже добавлен");
      return;
    }
    if (cmdPhones.length >= 30) {
      setError("Не больше 30 номеров за раз");
      return;
    }
    setCmdPhones((prev) => [...prev, { phone, name: cmdPhoneNameDraft.trim() }]);
    setCmdPhoneDraft("");
    setCmdPhoneNameDraft("");
    setCommandParse(null);
    setCmdPhonesUnresolved([]);
    setError("");
  }

  async function onParseCommand() {
    if (!commandText.trim()) return;
    if (cmdWhoMode === "contact" && cmdSelectedContacts.length === 0) {
      setError("Добавьте хотя бы одного клиента");
      return;
    }
    if (cmdWhoMode === "phone" && cmdPhones.length === 0) {
      setError("Добавьте хотя бы один телефон");
      return;
    }
    const massIntent = /отправ|разошли|рассыл|всем\s+этим|кп|презентац|файл/i.test(commandText);
    const manyContacts = cmdWhoMode === "contact" && cmdSelectedContacts.length > 1;
    const manyPhones = cmdWhoMode === "phone" && cmdPhones.length > 1;
    const hasPhoneBlob = /(\+?\d[\d\s\-()]{8,}\d).{0,40}(\+?\d[\d\s\-()]{8,}\d)/.test(commandText);
    if (massIntent && (manyContacts || manyPhones || hasPhoneBlob || cmdWhoMode === "list" || cmdWhoMode === "group" || cmdWhoMode === "import")) {
      setShowCampaignPanel(true);
      setComposeMode("campaign");
      setCampaignSeed({
        whoMode: manyContacts || cmdWhoMode === "group" ? (cmdWhoMode === "group" ? "segment" : "contacts") : hasPhoneBlob || manyPhones || cmdWhoMode === "list" ? "phones" : "phones",
        contactIds: cmdSelectedContacts.map((c) => c.id),
        phones:
          cmdWhoMode === "phone"
            ? cmdPhones.map((p) => p.phone).join("\n")
            : hasPhoneBlob
              ? commandText
              : undefined,
        command: commandText,
        message: commandDraft,
      });
      setError("");
      return;
    }
    setBusy(true);
    setBatchResult(null);
    setCommandTaskId(null);
    setCmdPhonesUnresolved([]);
    try {
      const data: any = await api.parseTaskCommand({
        text: commandText.trim(),
        contactIds: cmdWhoMode === "contact" ? cmdSelectedContacts.map((c) => c.id) : undefined,
        phones: cmdWhoMode === "phone" ? cmdPhones.map((item) => item.phone) : undefined,
        phoneListText: hasPhoneBlob ? commandText.trim() : undefined,
      });
      setCommandParse(data);
      const unresolved = (data.phonesUnresolved as string[]) || (data.phoneUnresolved ? [data.phoneUnresolved] : []);
      setCmdPhonesUnresolved(unresolved);
      const ids = (data.clients || []).map((item: PickerClient) => item.id);
      if (cmdWhoMode === "contact") {
        setCommandSelectedIds(cmdSelectedContacts.map((c) => c.id));
      } else {
        setCommandSelectedIds(ids);
      }
      setCommandDraft(
        data.command?.taskType === "proposal"
          ? "Добрый день! Во вложении коммерческое предложение. Готовы обсудить детали."
          : data.command?.taskType === "message" || /уточн/i.test(commandText)
            ? "Добрый день! Хотел уточнить, актуальна ли ещё заявка."
            : "",
      );
      if (data.asCampaign || ((data.clients?.length || 0) + unresolved.length > 5 && massIntent)) {
        setShowCampaignPanel(true);
        setComposeMode("campaign");
        setCampaignSeed({
          whoMode: unresolved.length || hasPhoneBlob ? "phones" : "contacts",
          contactIds: ids,
          phones: unresolved.length ? unresolved.join("\n") : hasPhoneBlob ? commandText : undefined,
          command: commandText,
          message:
            data.command?.taskType === "proposal"
              ? "{{firstName}}, добрый день! Направляем коммерческое предложение. Во вложении — условия и варианты работы."
              : commandDraft,
        });
      }
      setShowCreate(true);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось понять команду");
    } finally {
      setBusy(false);
    }
  }

  async function onCreateFromCommand() {
    const phonesPayload = cmdWhoMode === "phone" ? cmdPhones.map((item) => item.phone) : cmdPhonesUnresolved;
    if (!commandParse || (commandSelectedIds.length === 0 && phonesPayload.length === 0)) {
      setError("Выберите клиентов или добавьте телефоны");
      return;
    }
    setBusy(true);
    try {
      const nameByPhone = new Map(cmdPhones.map((item) => [item.phone, item.name]));
      const created: any = await api.createFromCommand({
        text: commandText.trim(),
        parsedCommand: commandParse.command,
        clientIds: commandSelectedIds,
        phones: phonesPayload.length ? phonesPayload : undefined,
        contactNames: phonesPayload.length ? phonesPayload.map((phone) => nameByPhone.get(phone) || "") : undefined,
        messageDraft: commandDraft || undefined,
        executionMode: commandParse.command?.executionMode || "execute",
        ownerMembershipId: ownerId || undefined,
      });
      setCommandTaskId(created.task?.id || null);
      if (created.task?.contactId) {
        setCommandSelectedIds([created.task.contactId]);
      } else if (created.task?.childTasks?.length) {
        setCommandSelectedIds(created.task.childTasks.map((c: any) => c.contactId).filter(Boolean));
      }
      if (created.executionMode === "prepare_only") {
        setBatchResult({ prepareOnly: true, message: created.nextStep });
      } else if ((commandParse.command?.riskLevel || 0) < 3) {
        setBatchResult({ prepareOnly: true, message: created.nextStep || "Задача создана" });
        setCommandParse(null);
        setCommandText("");
        setCmdSelectedContacts([]);
        setCmdPhones([]);
        setCmdPhonesUnresolved([]);
      }
      await load();
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать из команды");
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmCommandSend() {
    if (!commandTaskId) return;
    setBusy(true);
    try {
      const isGroup = commandSelectedIds.length > 1 || commandParse?.command?.targetType === "group";
      if (isGroup && commandSelectedIds.length > 1) {
        const result = await api.executeTaskBatch(commandTaskId);
        setBatchResult(result);
        setNextPanel({
          taskId: commandTaskId,
          actions: (result as any).nextActions || [],
        });
      } else {
        await api.prepareTaskExecution(commandTaskId);
        await api.confirmTaskExecution(commandTaskId);
        const result: any = await api.executeTask(commandTaskId);
        setBatchResult({
          total: 1,
          success: result.success ? 1 : 0,
          failed: result.success ? 0 : 1,
        });
        if (result.nextActions?.length) {
          setNextPanel({ taskId: commandTaskId, actions: result.nextActions });
        }
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Отправка не удалась");
    } finally {
      setBusy(false);
    }
  }

  const filterCounts = {
    open: items.filter((item) => item.status === "open").length,
    waiting: items.filter((item) => item.status === "waiting").length,
    overdue: items.filter(
      (item) => item.dueAt && new Date(item.dueAt) < now && item.status !== "done" && item.status !== "canceled",
    ).length,
    mine: items.filter((item) => item.ownerMembershipId === membershipId && item.status !== "done").length,
    all: items.length,
  };

  return (
    <section>
      <div className="page-head">
        <h2>Задачи</h2>
        <div className="actions">
          <button
            type="button"
            className={composeMode === "command" ? "btn" : "btn secondary"}
            onClick={() => {
              setComposeMode("command");
              setShowCampaignPanel(false);
              setShowCreate(true);
            }}
          >
            Поставить командой
          </button>
          <button
            type="button"
            className={composeMode === "campaign" || showCampaignPanel ? "btn" : "btn secondary"}
            onClick={() => {
              setComposeMode("campaign");
              setShowCampaignPanel(true);
              setCampaignSeed({ whoMode: "phones" });
              setShowCreate(true);
            }}
          >
            Массовая отправка
          </button>
          <button
            type="button"
            className={composeMode === "manual" ? "btn" : "btn secondary"}
            onClick={() => {
              setComposeMode("manual");
              setShowCampaignPanel(false);
              setShowCreate(true);
            }}
          >
            Настроить вручную
          </button>
        </div>
      </div>
      <div className="actions">
        {(
          [
            ["open", "Открытые"],
            ["waiting", "Жду"],
            ["overdue", "Просроченные"],
            ["mine", "Мои"],
            ["all", "Все"],
          ] as const
        ).map(([value, label]) => (
          <button key={value} className={filter === value ? "btn" : "btn secondary"} onClick={() => setFilter(value)}>
            {label} · {filterCounts[value]}
          </button>
        ))}
      </div>

      {showCreate && (composeMode === "campaign" || showCampaignPanel) ? (
        <CampaignMassPanel
          key={`${campaignSeed.whoMode || "phones"}-${(campaignSeed.contactIds || []).join(",")}-${(campaignSeed.phones || "").slice(0, 40)}`}
          initialPhoneText={campaignSeed.phones || ""}
          initialContactIds={campaignSeed.contactIds || []}
          initialSegment={campaignSeed.segment}
          initialMessage={campaignSeed.message || ""}
          commandText={campaignSeed.command || commandText}
          initialWhoMode={campaignSeed.whoMode}
          onClose={() => {
            setShowCampaignPanel(false);
            setComposeMode("command");
            setCampaignSeed({});
          }}
        />
      ) : null}

      {showCreate && composeMode === "command" && !showCampaignPanel ? (
        <div className="panel task-form command-compose">
          <div className="command-compose-head">
            <div>
              <b>Новая задача командой</b>
              <p className="muted">Сначала укажите, кому. Затем напишите, что сделать — своими словами.</p>
            </div>
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setShowCreate(false);
                setCommandParse(null);
              }}
            >
              Скрыть
            </button>
          </div>

          <div className="command-step">
            <div className="command-step-label">1. Кому</div>
            <div className="chip-row">
              {(
                [
                  ["contact", "Клиент из CRM"],
                  ["group", "Группа из CRM"],
                  ["phone", "По номеру"],
                  ["list", "Список номеров"],
                  ["import", "Импорт контактов"],
                  ["auto", "Из текста команды"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={cmdWhoMode === value ? "chip active" : "chip"}
                  onClick={() => {
                    setCmdWhoMode(value);
                    setCommandParse(null);
                    setCmdPhonesUnresolved([]);
                    if (value === "list" || value === "group" || value === "import") {
                      setShowCampaignPanel(true);
                      setComposeMode("campaign");
                      setCampaignSeed({
                        whoMode: value === "list" ? "phones" : value === "group" ? "segment" : "import",
                        contactIds: value === "group" ? selectedIds : cmdSelectedContacts.map((c) => c.id),
                        phones: value === "list" ? cmdPhones.map((p) => p.phone).join("\n") : undefined,
                        command: commandText,
                        message: commandDraft,
                        segment:
                          value === "group"
                            ? {
                                serviceCategories: serviceCategories.length ? serviceCategories : undefined,
                                statuses: statuses.length ? statuses : undefined,
                                sources: sources.length ? sources : undefined,
                                datePreset: datePreset || undefined,
                              }
                            : undefined,
                      });
                    }
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            {cmdWhoMode === "contact" ? (
              <div className="field-block">
                {cmdSelectedContacts.length ? (
                  <div className="cmd-selected-list">
                    <div className="muted" style={{ marginBottom: 6 }}>
                      Выбрано: {cmdSelectedContacts.length}
                    </div>
                    {cmdSelectedContacts.map((client) => (
                      <div key={client.id} className="selected-client compact">
                        <div>
                          <b>{client.name}</b>
                          <div className="muted">{[client.phone, client.interest].filter(Boolean).join(" · ") || "Без телефона"}</div>
                        </div>
                        <button
                          type="button"
                          className="btn secondary"
                          onClick={() => {
                            setCmdSelectedContacts((prev) => prev.filter((item) => item.id !== client.id));
                            setCommandParse(null);
                          }}
                        >
                          Убрать
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <label>
                  Добавить клиента
                  <input
                    value={cmdSearchQ}
                    onChange={(event) => setCmdSearchQ(event.target.value)}
                    placeholder="Имя, телефон или компания"
                  />
                </label>
                {cmdSearchHits.length > 0 ? (
                  <div className="picker-list">
                    {cmdSearchHits.map((hit) => {
                      const already = cmdSelectedContacts.some((item) => item.id === hit.id);
                      return (
                        <button
                          key={hit.id}
                          type="button"
                          className="picker-item"
                          disabled={already}
                          onClick={() => {
                            if (already) return;
                            setCmdSelectedContacts((prev) => [...prev, hit].slice(0, 30));
                            setCmdSearchQ("");
                            setCmdSearchHits([]);
                            setCommandParse(null);
                            setError("");
                          }}
                        >
                          <b>{hit.name}</b>
                          <div className="muted">
                            {[hit.phone, hit.interest, hit.statusLabel].filter(Boolean).join(" · ")}
                            {already ? " · уже выбран" : ""}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : cmdSearchQ.trim() ? (
                  <p className="muted">Никого не нашли. Попробуйте другой запрос или режим «По номерам».</p>
                ) : (
                  <p className="muted">Можно выбрать несколько клиентов подряд.</p>
                )}
              </div>
            ) : null}

            {cmdWhoMode === "phone" ? (
              <div className="field-block">
                {cmdPhones.length ? (
                  <div className="cmd-selected-list">
                    <div className="muted" style={{ marginBottom: 6 }}>
                      Номеров: {cmdPhones.length}
                    </div>
                    {cmdPhones.map((item) => (
                      <div key={item.phone} className="selected-client compact">
                        <div>
                          <b>{item.phone}</b>
                          {item.name ? <div className="muted">{item.name}</div> : null}
                        </div>
                        <button
                          type="button"
                          className="btn secondary"
                          onClick={() => {
                            setCmdPhones((prev) => prev.filter((row) => row.phone !== item.phone));
                            setCommandParse(null);
                            setCmdPhonesUnresolved([]);
                          }}
                        >
                          Убрать
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="command-phone-grid">
                  <label>
                    Телефон
                    <input
                      value={cmdPhoneDraft}
                      onChange={(event) => setCmdPhoneDraft(event.target.value)}
                      placeholder="+7 701 000 00 00"
                      inputMode="tel"
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addCmdPhone();
                        }
                      }}
                    />
                  </label>
                  <label>
                    Имя (если нового)
                    <input
                      value={cmdPhoneNameDraft}
                      onChange={(event) => setCmdPhoneNameDraft(event.target.value)}
                      placeholder="Необязательно"
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          addCmdPhone();
                        }
                      }}
                    />
                  </label>
                </div>
                <div className="actions">
                  <button type="button" className="btn secondary" onClick={addCmdPhone} disabled={cmdPhoneDraft.trim().length < 5}>
                    Добавить номер
                  </button>
                </div>
                <p className="muted">Несколько номеров — по одному. Существующие найдём, новых создадим при постановке.</p>
              </div>
            ) : null}

            {cmdWhoMode === "auto" ? (
              <p className="muted">CRM сама найдёт клиента или группу по тексту команды (имя, «вчерашним», услуга…).</p>
            ) : null}
          </div>

          <div className="command-step">
            <div className="command-step-label">2. Что сделать</div>
            <textarea
              value={commandText}
              onChange={(event) => {
                setCommandText(event.target.value);
                setCommandParse(null);
              }}
              rows={3}
              placeholder='Например: «Уточни, актуальна ли заявка» или «Отправь КП»'
            />
            <div className="chip-row">
              {[
                "Уточни, актуальна ли заявка.",
                "Позвони и обсуди детали.",
                "Напиши и уточни по оплате.",
                "Отправь КП.",
              ].map((example) => (
                <button
                  key={example}
                  type="button"
                  className="chip"
                  onClick={() => {
                    setCommandText(example);
                    setCommandParse(null);
                  }}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>

          <div className="actions">
            <button
              type="button"
              className="btn"
              disabled={
                busy ||
                !commandText.trim() ||
                (cmdWhoMode === "contact" && cmdSelectedContacts.length === 0) ||
                (cmdWhoMode === "phone" && cmdPhones.length === 0)
              }
              onClick={onParseCommand}
            >
              Понять задачу
            </button>
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setCommandText("");
                setCommandParse(null);
                setCmdSelectedContacts([]);
                setCmdPhones([]);
                setCmdPhoneDraft("");
                setCmdPhoneNameDraft("");
                setCmdPhonesUnresolved([]);
                setBatchResult(null);
                setCommandTaskId(null);
              }}
            >
              Очистить
            </button>
          </div>

          {commandParse ? (
            <div className="command-understanding">
              <h3>Так CRM поняла задачу</h3>
              <div className="command-summary">
                <div>
                  <span className="muted">Действие</span>
                  <b>{commandParse.understanding?.action}</b>
                </div>
                <div>
                  <span className="muted">Кому</span>
                  <b>{commandParse.understanding?.who}</b>
                </div>
                <div>
                  <span className="muted">Когда</span>
                  <b>{commandParse.understanding?.when}</b>
                </div>
              </div>
              <p className="muted">{commandParse.understanding?.consequence}</p>

              {(commandParse.command?.ambiguities || []).length ? (
                <div className="banner warn">
                  {(commandParse.command.ambiguities as string[]).map((item) => (
                    <div key={item}>{item}</div>
                  ))}
                </div>
              ) : null}

              {cmdPhonesUnresolved.length ? (
                <div className="panel soft">
                  <b>Новые клиенты по номерам</b>
                  <ul className="cmd-phone-unresolved">
                    {cmdPhonesUnresolved.map((phone) => {
                      const name = cmdPhones.find((item) => item.phone === phone)?.name;
                      return (
                        <li key={phone}>
                          {phone}
                          {name ? ` · ${name}` : ""}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="muted">Создадим при постановке задачи.</p>
                </div>
              ) : null}

              {(commandParse.clients || []).length > 0 ? (
                <div className="field-block">
                  <div className="muted" style={{ marginBottom: 8 }}>
                    Получатели · выбрано {commandSelectedIds.length}
                    {(commandParse.clients || []).length > 1 ? (
                      <>
                        {" · "}
                        <button
                          type="button"
                          className="linkish"
                          onClick={() => setCommandSelectedIds((commandParse.clients || []).map((c: any) => c.id))}
                        >
                          Выбрать всех
                        </button>
                      </>
                    ) : null}
                  </div>
                  <div className="picker-list">
                    {(commandParse.clients || []).map((client: PickerClient) => {
                      const checked = commandSelectedIds.includes(client.id);
                      const multi = (commandParse.clients || []).length > 1;
                      return (
                        <label key={client.id} className="picker-item check">
                          {multi ? (
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setCommandSelectedIds((prev) =>
                                  checked ? prev.filter((id) => id !== client.id) : [...prev, client.id],
                                )
                              }
                            />
                          ) : (
                            <input type="radio" checked readOnly />
                          )}
                          <span>
                            <b>{client.name}</b>
                            <div className="muted">
                              {[client.phone, client.interest, client.lastContactLabel].filter(Boolean).join(" · ")}
                            </div>
                            {client.id ? (
                              <Link to={`/contacts/${client.id}`} onClick={(e) => e.stopPropagation()}>
                                Открыть
                              </Link>
                            ) : null}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {commandParse.command?.riskLevel >= 3 ||
              commandParse.command?.taskType === "proposal" ||
              commandParse.command?.taskType === "message" ? (
                <label>
                  Сообщение клиенту
                  <textarea value={commandDraft} onChange={(event) => setCommandDraft(event.target.value)} rows={3} />
                </label>
              ) : null}

              <div className="actions">
                <button type="button" className="btn secondary" onClick={() => setCommandParse(null)}>
                  Изменить
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={
                    busy ||
                    (commandSelectedIds.length === 0 &&
                      cmdPhonesUnresolved.length === 0 &&
                      !(cmdWhoMode === "phone" && cmdPhones.length > 0))
                  }
                  onClick={onCreateFromCommand}
                >
                  {commandParse.command?.executionMode === "prepare_only"
                    ? "Подготовить черновик"
                    : commandParse.command?.riskLevel >= 3
                      ? "Подготовить к исполнению"
                      : "Создать задачу"}
                </button>
              </div>

              {commandTaskId && commandParse.command?.riskLevel >= 3 && commandParse.command?.executionMode !== "prepare_only" ? (
                <div className="panel soft" style={{ marginTop: 12 }}>
                  <b>Проверьте перед отправкой</b>
                  <p>
                    {commandParse.understanding?.action}
                    {" · "}
                    {Math.max(commandSelectedIds.length, cmdPhones.length, cmdPhonesUnresolved.length)}{" "}
                    {Math.max(commandSelectedIds.length, cmdPhones.length, cmdPhonesUnresolved.length) === 1
                      ? "клиенту"
                      : "клиентам"}{" "}
                    через WhatsApp.
                  </p>
                  <div className="actions">
                    <button type="button" className="btn secondary" onClick={() => setCommandTaskId(null)}>
                      Вернуться и изменить
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={onConfirmCommandSend}>
                      Подтвердить и отправить
                    </button>
                  </div>
                </div>
              ) : null}

              {batchResult ? (
                <div className="panel soft" style={{ marginTop: 12 }}>
                  {batchResult.prepareOnly ? (
                    <p>{batchResult.message}</p>
                  ) : (
                    <>
                      <b>Выполнено</b>
                      <p>
                        Успешно: {batchResult.success} · Ошибка: {batchResult.failed} · Всего: {batchResult.total}
                      </p>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {showCreate && composeMode === "manual" ? (
      <form className="panel task-form" onSubmit={submitTask}>
        <b>Новая задача</b>

        <label>
          Тип
          <select
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              if (!title.trim()) {
                setTitle(suggestedTitle(event.target.value, targetMode, selectedClient, selectedIds.length, segmentLabel));
              }
            }}
          >
            {TASK_TYPES.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <div className="field-block">
          <div className="muted" style={{ marginBottom: 8 }}>
            Кому относится задача
          </div>
          <div className="chip-row">
            {(
                [
                ["client", "Один клиент"],
                ["group", "Группа CRM"],
                ["list", "Список номеров"],
                ["import", "Импорт контактов"],
                ["none", "Без привязки"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={targetMode === value || (value === "list" && showCampaignPanel && campaignSeed.whoMode === "phones") || (value === "import" && campaignSeed.whoMode === "import") ? "chip active" : "chip"}
                onClick={() => {
                  if (value === "list" || value === "import") {
                    setComposeMode("campaign");
                    setShowCampaignPanel(true);
                    setCampaignSeed({
                      whoMode: value === "list" ? "phones" : "import",
                      message: messageDraft,
                    });
                    return;
                  }
                  setTargetMode(value as TargetMode);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {targetMode === "client" ? (
          <div className="field-block">
            {!selectedClient ? (
              <label>
                Клиент
                <input
                  value={searchQ}
                  onChange={(event) => setSearchQ(event.target.value)}
                  placeholder="Имя, телефон, компания или задача клиента"
                />
              </label>
            ) : null}
            {!selectedClient && searchHits.length > 0 ? (
              <div className="picker-list">
                {searchHits.map((hit) => (
                  <button
                    key={hit.id}
                    type="button"
                    className="picker-item"
                    onClick={() => {
                      setSelectedClient(hit);
                      setSearchQ("");
                    }}
                  >
                    <b>{hit.name}</b>
                    <div className="muted">
                      {[hit.phone, hit.interest, hit.statusLabel].filter(Boolean).join(" · ")}
                    </div>
                    {hit.lastContactLabel ? <div className="muted">Последний контакт: {hit.lastContactLabel}</div> : null}
                  </button>
                ))}
              </div>
            ) : null}

            {selectedClient ? (
              <div className="selected-client">
                <div>
                  <b>{selectedClient.name}</b>
                  <div className="muted">{selectedClient.phone || "Телефон не указан"}</div>
                  {overview?.currentRequest ? (
                    <div className="muted">
                      Текущая заявка: {overview.currentRequest.title} · {overview.currentRequest.statusLabel}
                    </div>
                  ) : null}
                  {overview?.attribution?.sourceType || selectedClient.source ? (
                    <div className="muted">Источник: {overview?.attribution?.sourceType || selectedClient.source}</div>
                  ) : null}
                  {selectedClient.lastContactLabel || overview?.control?.lastContactLabel ? (
                    <div className="muted">
                      Последний контакт: {overview?.control?.lastContactLabel || selectedClient.lastContactLabel}
                    </div>
                  ) : null}
                </div>
                <button type="button" className="btn secondary" onClick={() => setSelectedClient(null)}>
                  Изменить клиента
                </button>
              </div>
            ) : null}

            {overview ? (
              <>
                <label>
                  Заявка
                  <select value={inquiryId} onChange={(event) => setInquiryId(event.target.value)}>
                    <option value="">Без заявки</option>
                    {(overview.requests || []).map((item: any) => (
                      <option key={item.id} value={item.id}>
                        {item.title} · {item.statusLabel} · {item.receivedLabel}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Сделка
                  <select value={dealId} onChange={(event) => setDealId(event.target.value)}>
                    <option value="">Сделки нет</option>
                    {(overview.deals || []).map((item: any) => (
                      <option key={item.id} value={item.id}>
                        {item.title}
                        {item.stage ? ` · ${item.stage}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Диалог
                  <select value={conversationId} onChange={(event) => setConversationId(event.target.value)}>
                    <option value="">Без диалога</option>
                    {(overview.conversations || []).map((item: any) => (
                      <option key={item.id} value={item.id}>
                        {item.channel} · {item.updatedLabel}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : null}
          </div>
        ) : null}

        {targetMode === "group" ? (
          <div className="field-block">
            <div className="muted" style={{ marginBottom: 8 }}>
              Быстрый выбор
            </div>
            <div className="chip-row">
              {QUICK_SEGMENTS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="chip"
                  onClick={() => {
                    if (item.body.serviceCategories) setServiceCategories(item.body.serviceCategories as string[]);
                    if (item.body.datePreset) setDatePreset(String(item.body.datePreset));
                    runPreview(item.body as Record<string, unknown>, item.label);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="filter-grid">
              <div>
                <div className="muted">Интерес / услуга</div>
                <div className="chip-row">
                  {SERVICE_OPTIONS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={serviceCategories.includes(item.id) ? "chip active" : "chip"}
                      onClick={() => setServiceCategories(toggleValue(serviceCategories, item.id))}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="muted">Дата обращения</div>
                <select value={datePreset} onChange={(event) => setDatePreset(event.target.value)}>
                  <option value="">Любая</option>
                  <option value="today">Сегодня</option>
                  <option value="yesterday">Вчера</option>
                  <option value="last_3_days">Последние 3 дня</option>
                  <option value="last_7_days">Последние 7 дней</option>
                  <option value="last_30_days">Последние 30 дней</option>
                  <option value="this_month">Этот месяц</option>
                </select>
              </div>
              <div>
                <div className="muted">Статус</div>
                <div className="chip-row">
                  {STATUS_OPTIONS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={statuses.includes(item.id) ? "chip active" : "chip"}
                      onClick={() => setStatuses(toggleValue(statuses, item.id))}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="muted">Источник</div>
                <div className="chip-row">
                  {SOURCE_OPTIONS.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={sources.includes(item.id) ? "chip active" : "chip"}
                      onClick={() => setSources(toggleValue(sources, item.id))}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="actions" style={{ marginTop: 12 }}>
              <button type="button" className="btn secondary" disabled={previewBusy} onClick={() => runPreview()}>
                {previewBusy ? "Ищем…" : "Показать клиентов"}
              </button>
              {segmentClients.length ? (
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => setSelectedIds(segmentClients.map((item) => item.id))}
                >
                  Выбрать всех {segmentClients.length}
                </button>
              ) : null}
            </div>

            {segmentTotal > 0 ? (
              <p className="muted">
                Найдено: {segmentTotal} · Выбрано: {selectedIds.length}
                {segmentLabel ? ` · ${segmentLabel}` : ""}
              </p>
            ) : null}

            <div className="picker-list">
              {segmentClients.map((client) => {
                const checked = selectedIds.includes(client.id);
                return (
                  <label key={client.id} className="picker-item check">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() =>
                        setSelectedIds((prev) =>
                          checked ? prev.filter((id) => id !== client.id) : [...prev, client.id],
                        )
                      }
                    />
                    <span>
                      <b>{client.name}</b>
                      <div className="muted">
                        {[client.phone, client.interest, client.lastContactLabel].filter(Boolean).join(" · ")}
                      </div>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        <label>
          Название
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={suggestedTitle(type, targetMode, selectedClient, selectedIds.length, segmentLabel)}
            required={false}
          />
        </label>
        <label>
          Описание
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        {SENDABLE.has(type) ? (
          <label>
            Текст сообщения клиенту
            <textarea
              value={messageDraft}
              onChange={(event) => setMessageDraft(event.target.value)}
              placeholder="Текст, который уйдёт клиенту после подтверждения"
            />
          </label>
        ) : null}
        <label>
          Ответственный
          <select value={ownerId} onChange={(event) => setOwnerId(event.target.value)} required>
            <option value="">Выберите</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
                {member.isMe ? " (я)" : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          Срок
          <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
        </label>
        <label>
          Приоритет
          <select value={priority} onChange={(event) => setPriority(event.target.value)}>
            <option value="low">Низкий</option>
            <option value="normal">Обычный</option>
            <option value="high">Высокий</option>
          </select>
        </label>
        <div className="actions">
          <button className="btn">Создать</button>
          <button type="button" className="btn secondary" onClick={() => setShowCreate(false)}>
            Скрыть
          </button>
        </div>
      </form>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

      {activeTaskId && taskDetail && !preview ? (
        <div className="panel task-form">
          <b>Подготовка отправки</b>
          <div className="muted">{taskDetail.title}</div>
          <label>
            Сообщение
            <textarea value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} rows={5} />
          </label>
          <label>
            Тип файла
            <select value={docType} onChange={(event) => setDocType(event.target.value)}>
              <option value="proposal">Коммерческое предложение</option>
              <option value="presentation">Презентация</option>
              <option value="contract">Договор</option>
              <option value="invoice">Счёт</option>
              <option value="document">Документ</option>
              <option value="other">Другое</option>
            </select>
          </label>
          <label>
            Прикрепить файл
            <input
              type="file"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.webp,.zip"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) onAttachFile(file);
                event.target.value = "";
              }}
            />
          </label>
          {(taskDetail.attachments || []).length ? (
            <div className="picker-list">
              {taskDetail.attachments.map((file: any) => (
                <div key={file.id} className="picker-item">
                  <b>{file.originalFileName || file.fileName}</b>
                  <div className="muted">
                    {file.documentType} · {(file.sizeBytes / 1024).toFixed(0)} КБ
                    {file.sendState === "failed" ? " · не отправлен" : ""}
                  </div>
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() =>
                      api
                        .removeTaskAttachment(activeTaskId, file.id)
                        .then(() => api.task(activeTaskId).then(setTaskDetail))
                        .catch((err) => setError(err.message))
                    }
                  >
                    Удалить файл
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="actions">
            <button type="button" className="btn secondary" onClick={() => { setActiveTaskId(null); setTaskDetail(null); }}>
              Закрыть
            </button>
            <button type="button" className="btn" disabled={busy} onClick={onPrepare}>
              Подготовить отправку
            </button>
          </div>
        </div>
      ) : null}

      {preview ? (
        <div className="panel task-form confirm-panel">
          <b>Проверьте перед отправкой</b>
          <p className="muted">CRM поняла задачу следующим образом:</p>
          <div className="kv">
            <div><span>Действие</span><b>{preview.actionLabel}</b></div>
            <div><span>Кому</span><b>{preview.client?.name}</b></div>
            <div><span>Телефон</span><b>{preview.client?.phone || "не указан"}</b></div>
            <div><span>По заявке</span><b>{preview.request?.title || "Не указано"}</b></div>
            <div><span>Канал</span><b>{preview.channel}</b></div>
          </div>
          <div className="message-preview">{preview.message}</div>
          {(preview.attachments || []).length ? (
            <div className="picker-list">
              {preview.attachments.map((file: any) => (
                <div key={file.id} className="picker-item">
                  <b>{file.fileName}</b>
                  <div className="muted">
                    {file.documentType} · {file.sizeLabel}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">Без вложений</p>
          )}
          {execResult && !(execResult as any).success ? (
            <div className="error">
              {(execResult as any).textOk ? "Сообщение отправлено ✓" : "Сообщение не отправлено ✕"}
              {(execResult as any).files?.map((f: any) => (
                <div key={f.id}>
                  {f.fileName}: {f.ok ? "✓" : `✕ ${f.error || ""}`}
                </div>
              ))}
            </div>
          ) : null}
          <div className="actions">
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setPreview(null);
              }}
            >
              Вернуться и изменить
            </button>
            {execResult && (execResult as any).retryFilesAvailable ? (
              <button type="button" className="btn" disabled={busy} onClick={onRetryFiles}>
                Повторить отправку файла
              </button>
            ) : (
              <button type="button" className="btn" disabled={busy} onClick={onConfirmAndSend}>
                Подтвердить и отправить
              </button>
            )}
          </div>
        </div>
      ) : null}

      {nextPanel ? (
        <div className="panel task-form">
          <b>Что дальше?</b>
          <p className="muted">Задача выполнена. Выберите следующий шаг или закройте.</p>
          <div className="chip-row">
            {nextPanel.actions.map((action) => (
              <button
                key={action.title}
                type="button"
                className="chip"
                onClick={() =>
                  api
                    .createNextAction(nextPanel.taskId, action)
                    .then(() => {
                      setNextPanel(null);
                      return load();
                    })
                    .catch((err) => setError(err.message))
                }
              >
                {action.title}
              </button>
            ))}
            <button type="button" className="chip" onClick={() => setNextPanel(null)}>
              Без следующего действия
            </button>
          </div>
        </div>
      ) : null}

      {completeOpen ? (
        <div className="panel task-form">
          <b>Завершить задачу</b>
          <label>
            Результат
            <select value={resultCode} onChange={(event) => setResultCode(event.target.value)}>
              <option value="reached">Дозвонился</option>
              <option value="no_answer">Не ответил</option>
              <option value="callback_later">Перезвонить позже</option>
              <option value="refused">Клиент отказался</option>
              <option value="agreed">Договорились</option>
              <option value="other">Другое</option>
            </select>
          </label>
          <div className="actions">
            <button type="button" className="btn secondary" onClick={() => setCompleteOpen(null)}>
              Отмена
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                api
                  .completeTaskResult(completeOpen, { resultCode })
                  .then((data: any) => {
                    setCompleteOpen(null);
                    setNextPanel({ taskId: completeOpen, actions: data.suggestedNextActions || [] });
                    return load();
                  })
                  .catch((err) => setError(err.message))
              }
            >
              Завершить задачу
            </button>
          </div>
        </div>
      ) : null}

      {visible.length === 0 ? (
        <p className="empty">
          {filter === "open"
            ? "Открытых задач нет."
            : filter === "waiting"
              ? "Задач в ожидании нет."
              : filter === "overdue"
                ? "Просроченных задач нет."
                : filter === "mine"
                  ? "У вас нет активных задач."
                  : "Задач пока нет."}
        </p>
      ) : null}

      {groups.map((group) =>
        group.items.length === 0 ? null : (
          <div key={group.key}>
            <h3>{GROUP_TITLE[group.key]}</h3>
            {group.items.map((item) => (
              <div className="row" key={item.id}>
                <div>
                  <b>{item.title}</b>
                  <div className="muted">
                    {item.status} · {TASK_TYPES.find(([id]) => id === item.type)?.[1] || item.type}
                    {item.owner?.user?.name ? ` · ${item.owner.user.name}` : ""}
                    {item.dueAt ? ` · до ${new Date(item.dueAt).toLocaleString("ru-RU")}` : ""}
                  </div>
                  <div className="muted">
                    {item.targetType === "group" ? (
                      <>
                        Группа · {(item.segmentSnapshotJson as any)?.label || item.contextLabel}
                        {item.progress ? ` · выполнено ${item.progress.label}` : ""}
                      </>
                    ) : item.contact ? (
                      <>
                        <Link to={`/contacts/${item.contact.id}`}>
                          {item.contact.name || [item.contact.firstName, item.contact.lastName].filter(Boolean).join(" ")}
                        </Link>
                        {item.inquiry?.subject ? ` · ${item.inquiry.subject}` : ""}
                      </>
                    ) : (
                      item.contextLabel
                    )}
                  </div>
                  {item.targetType === "group" && item.children?.length ? (
                    <div style={{ marginTop: 8 }}>
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                      >
                        {expanded === item.id ? "Скрыть клиентов" : `Клиенты (${item.children.length})`}
                      </button>
                      {expanded === item.id ? (
                        <div className="picker-list" style={{ marginTop: 8 }}>
                          {item.children.map((child: any) => (
                            <div key={child.id} className="picker-item">
                              <b>
                                {child.status === "done" ? "✓ " : "○ "}
                                {child.contactName || "Клиент"}
                              </b>
                              <div className="actions" style={{ marginTop: 6 }}>
                                {child.status === "open" || child.status === "waiting" ? (
                                  <button
                                    className="btn"
                                    type="button"
                                    onClick={() =>
                                      api
                                        .completeTask(child.id)
                                        .then(load)
                                        .catch((err) => setError(err instanceof Error ? err.message : "Ошибка"))
                                    }
                                  >
                                    Сделано
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
                <div className="actions">
                  {item.status === "open" || item.status === "waiting" ? (
                    <>
                      {SENDABLE.has(item.type) && item.targetType !== "group" ? (
                        <button className="btn" type="button" onClick={() => openTaskEditor(item.id)}>
                          Подготовить отправку
                        </button>
                      ) : null}
                      {MANUAL_COMPLETE.has(item.type) ? (
                        <button className="btn secondary" type="button" onClick={() => setCompleteOpen(item.id)}>
                          Завершить
                        </button>
                      ) : null}
                      {item.status === "open" ? (
                        <button className="btn secondary" onClick={() => api.waitTask(item.id).then(load).catch((err) => setError(err.message))}>
                          Жду
                        </button>
                      ) : null}
                      {item.status === "waiting" ? (
                        <button className="btn secondary" onClick={() => api.reopenTask(item.id).then(load).catch((err) => setError(err.message))}>
                          Вернуть
                        </button>
                      ) : null}
                      {!SENDABLE.has(item.type) ? (
                        <button
                          className="btn"
                          onClick={() =>
                            api
                              .completeTask(item.id)
                              .then(load)
                              .catch((err) => setError(err instanceof Error ? err.message : "Нельзя закрыть"))
                          }
                        >
                          Сделано
                        </button>
                      ) : null}
                      <button className="btn danger" onClick={() => api.cancelTask(item.id).then(load).catch((err) => setError(err.message))}>
                        Отменить
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ),
      )}
    </section>
  );
}
