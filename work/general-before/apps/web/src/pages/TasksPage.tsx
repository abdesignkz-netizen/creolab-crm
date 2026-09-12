import { useUrlState, useRequestVersion } from "../lib/useUrlState";
import { useEffect, useMemo, useState, type DragEvent, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { nameWithPhone, phoneText } from "../lib/contactDisplay";
import { api } from "../lib/api";
import { tip } from "../lib/tip";
import { CALLS_ENABLED } from "../lib/featureFlags";
import { CampaignMassPanel } from "./CampaignMassPanel";
import { formatDateTimeLocalInput, formatDateTimeRu, parseDateTimeLocalInput, toDateTimeLocalValue } from "../lib/period";

type Filter = "open" | "waiting" | "scheduled" | "overdue" | "mine" | "done" | "all";
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

type PendingAttachment = {
  localId: string;
  fileName: string;
  mimeType: string;
  contentBase64: string;
  documentType: string;
  sizeBytes: number;
};

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function isInternalBriefingText(text: string) {
  return /Уже известно:|Уточнить:|следующий коммерческий шаг/i.test(text);
}

function resolveOutboundDraft(detail: any): string {
  const stored = String(detail?.messageDraft || "").trim();
  if (stored && !isInternalBriefingText(stored)) return stored;
  const fromSnap = String(detail?.contextSnapshotJson?.clientMessageDraft || "").trim();
  if (fromSnap) return fromSnap;
  return "";
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

function guessDocumentType(file: File) {
  const name = file.name.toLowerCase();
  if (file.type.startsWith("image/")) return "image";
  if (name.includes("кп") || name.includes("offer") || name.includes("proposal") || name.includes("коммерч")) {
    return "proposal";
  }
  if (name.includes("договор") || name.includes("contract")) return "contract";
  if (name.includes("счет") || name.includes("счёт") || name.includes("invoice")) return "invoice";
  if (name.includes("презентац") || name.includes("ppt")) return "presentation";
  return "document";
}

async function filesToPending(files: FileList | File[]): Promise<PendingAttachment[]> {
  const out: PendingAttachment[] = [];
  for (const file of Array.from(files)) {
    const contentBase64 = await readFileBase64(file);
    out.push({
      localId: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      contentBase64,
      documentType: guessDocumentType(file),
      sizeBytes: file.size,
    });
  }
  return out;
}

const GROUP_TITLE: Record<string, string> = {
  overdue: "Просрочено",
  today: "Сегодня",
  later: "Запланировано",
  none: "Без срока",
};

function toDateTimeLocal(value: Date) {
  return toDateTimeLocalValue(value);
}

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

const CREATE_TASK_TYPES = CALLS_ENABLED
  ? TASK_TYPES
  : TASK_TYPES.filter(([id]) => id !== "call");

const QUICK_SEGMENTS: Array<{
  id: string;
  label: string;
  body: {
    datePreset?: string;
    dateField?: string;
    serviceCategories?: string[];
    needsReply?: boolean;
    missingNextAction?: boolean;
    hot?: boolean;
    hasOverdueTask?: boolean;
  };
}> = [
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
];

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

function isFutureDue(value?: string | Date | null, now = Date.now()) {
  if (!value) return false;
  const due = value instanceof Date ? value : parseDateTimeLocalInput(value);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() > now;
}

function isScheduledSend(item: any, now = Date.now()) {
  if (item.status === "done" || item.status === "canceled") return false;
  if (item.dueAt && new Date(item.dueAt).getTime() <= now) return false;
  return Boolean(item.sendScheduled || item.executionStatus === "scheduled" || item.commandStatus === "scheduled");
}

function dueGroup(item: any, now: Date) {
  if (isScheduledSend(item) && item.status !== "done" && item.status !== "canceled") return "later";
  if (!item.dueAt) return "none";
  const due = new Date(item.dueAt);
  if (due.getTime() < now.getTime() && item.status !== "done" && item.status !== "canceled") return "overdue";
  if (due.getTime() > now.getTime()) return "later";
  if (due.toDateString() === now.toDateString()) return "today";
  return "later";
}

function isClosedTask(item: { status?: string }) {
  return item.status === "done" || item.status === "canceled";
}

function startOfDay(value: Date) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function taskDoneAt(item: any) {
  const raw = item.doneAt || item.completedAt || item.sentAt || item.updatedAt;
  return raw ? new Date(raw) : new Date(0);
}

function doneDateLabel(value: Date, now: Date) {
  const day = startOfDay(value);
  const today = startOfDay(now);
  if (day === today) return "Сегодня";
  if (day === today - 86400000) return "Вчера";
  return value.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

function groupDoneByDate(list: any[], now: Date) {
  const buckets = new Map<number, { key: number; title: string; items: any[] }>();
  for (const item of list) {
    const at = taskDoneAt(item);
    const key = startOfDay(at);
    const bucket = buckets.get(key) || { key, title: doneDateLabel(at, now), items: [] };
    bucket.items.push(item);
    buckets.set(key, bucket);
  }
  return [...buckets.values()]
    .sort((a, b) => b.key - a.key)
    .map((bucket) => ({
      ...bucket,
      items: [...bucket.items].sort((a, b) => taskDoneAt(b).getTime() - taskDoneAt(a).getTime()),
    }));
}

function taskResultLine(item: any) {
  const text = String(item.resultText || "").trim();
  if (item.doneSummary && text && !String(item.doneSummary).includes(text)) {
    return `${item.doneSummary}: ${text}`;
  }
  if (item.doneSummary) return item.doneSummary;
  if (item.resultLabel && text) return `${item.resultLabel}: ${text}`;
  if (text) return text;
  if (item.resultLabel) return item.resultLabel;
  if (item.status === "canceled") return "Отменена";
  if (item.status === "done") return "Сделано";
  return null;
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
  const [filter, setFilter] = useUrlState<Filter>("filter", "open", ["open", "waiting", "scheduled", "overdue", "mine", "done", "all"]);
  const [me, setMe] = useState<any>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [messageDraft, setMessageDraft] = useState("");
  const [editDueAt, setEditDueAt] = useState("");
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [execResult, setExecResult] = useState<any>(null);
  const [nextPanel, setNextPanel] = useState<{ taskId: string; actions: any[]; note?: string } | null>(null);
  const [completeOpen, setCompleteOpen] = useState<string | null>(null);
  const [completeTaskType, setCompleteTaskType] = useState<string>("call");
  const [resultCode, setResultCode] = useState("reached");
  const [resultText, setResultText] = useState("");
  const [docType, setDocType] = useState("proposal");
  const [busy, setBusy] = useState(false);

  const SENDABLE = new Set(["proposal", "message", "send_documents", "prepare_estimate", "follow_up", "process_inquiry"]);
  const MANUAL_COMPLETE = new Set(["call", "meeting", "payment", "wait_client", "process_inquiry", "other"]);

  const [targetMode, setTargetMode] = useState<TargetMode>("client");
  const [type, setType] = useState(CALLS_ENABLED ? "call" : "message");
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
  const [commandDueMode, setCommandDueMode] = useState<"now" | "scheduled">("now");
  const [commandDueAt, setCommandDueAt] = useState("");
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
    pendingAttachments?: PendingAttachment[];
  }>({});
  const [cmdPendingFiles, setCmdPendingFiles] = useState<PendingAttachment[]>([]);

  const [whatsappReady, setWhatsappReady] = useState<boolean | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  async function load() {
    try {
      const [data, profile, memberData, setup] = await Promise.all([
        api.tasks(),
        api.me(),
        api.workspaceMembers(),
        api.integrationSetup().catch(() => null),
      ]);
      setItems((data as { items: any[] }).items);
      setMe(profile);
      setMembers((memberData as { items: any[] }).items);
      const mid = (profile as any)?.activeTenant?.membershipId || (memberData as { items: any[] }).items.find((m) => m.isMe)?.id;
      if (mid && !ownerId) setOwnerId(mid);
      const wa = (setup as any)?.whatsapp;
      setWhatsappReady(Boolean(wa?.configured && wa?.reachable !== false));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  useEffect(() => {
    load();
  }, []);

  useEffect(() => {
    const openId = searchParams.get("open");
    const fromInquiry = searchParams.get("inquiryId");
    const fromContact = searchParams.get("contactId");
    const fromConversation = searchParams.get("conversationId");
    const fromDeal = searchParams.get("dealId");
    const fromCommand = searchParams.get("command");
    if (fromCommand) {
      setCommandText(fromCommand);
      setComposeMode("command");
      setShowCampaignPanel(false);
      setShowCreate(true);
    }
    if (!openId && !fromInquiry && !fromContact && !fromConversation && !fromDeal && !fromCommand) return;

    let cancelled = false;

    async function applyDeepLinks() {
      if (openId) {
        await openTaskEditor(openId);
      }

      const needsCompose = Boolean(fromInquiry || fromContact || fromConversation || fromDeal);
      if (needsCompose) {
        setShowCreate(true);
        setComposeMode("manual");
        setTargetMode("client");
      }

      if (fromInquiry) {
        setInquiryId(fromInquiry);
        try {
          const inquiry: any = await api.inquiry(fromInquiry);
          if (cancelled) return;
          if (inquiry?.contactId) {
            setSelectedClient({
              id: inquiry.contactId,
              name: inquiry.contact?.name || inquiry.contactName || "Клиент",
              phone: inquiry.contact?.phone || inquiry.phoneNormalized || inquiry.phoneRaw || null,
              companyName: inquiry.contact?.companyName || inquiry.companyName || null,
              inquiryId: inquiry.id,
              dealId: inquiry.dealId || null,
              conversationId: inquiry.conversationId || null,
            });
          }
          if (inquiry?.dealId) setDealId(inquiry.dealId);
          if (inquiry?.conversationId) setConversationId(inquiry.conversationId);
        } catch {
          // keep inquiryId prefilled even if detail fetch fails
        }
      } else if (fromContact || fromConversation || fromDeal) {
        if (fromDeal) setDealId(fromDeal);
        if (fromConversation) setConversationId(fromConversation);
        if (fromInquiry) setInquiryId(fromInquiry);

        try {
          if (fromContact) {
            const overview: any = await api.contactOverview(fromContact);
            if (cancelled) return;
            const client = overview?.client || overview;
            setSelectedClient({
              id: fromContact,
              name: client?.name || "Клиент",
              phone: client?.phone || null,
              companyName: client?.companyName || null,
              inquiryId: overview?.currentRequest?.id || null,
              dealId: fromDeal || overview?.deals?.[0]?.id || null,
              conversationId: fromConversation || overview?.conversations?.[0]?.id || null,
            });
            if (!fromInquiry && overview?.currentRequest?.id) setInquiryId(overview.currentRequest.id);
            if (!fromDeal && overview?.deals?.[0]?.id) setDealId(overview.deals[0].id);
            if (!fromConversation && overview?.conversations?.[0]?.id) {
              setConversationId(overview.conversations[0].id);
            }
          } else if (fromConversation) {
            const ws: any = await api.conversation(fromConversation);
            if (cancelled) return;
            const contactId = ws?.client?.id || ws?.conversation?.contactId;
            if (contactId) {
              setSelectedClient({
                id: contactId,
                name: ws?.client?.name || "Клиент",
                phone: ws?.client?.phone || null,
                companyName: ws?.client?.companyName || null,
                inquiryId: ws?.inquiry?.id || null,
                dealId: fromDeal || ws?.deal?.id || null,
                conversationId: fromConversation,
              });
              if (ws?.inquiry?.id) setInquiryId(ws.inquiry.id);
              if (!fromDeal && ws?.deal?.id) setDealId(ws.deal.id);
            }
          } else if (fromDeal) {
            const deal: any = await api.deal(fromDeal);
            if (cancelled) return;
            const contactId = deal?.contact?.id || deal?.contactId;
            if (contactId) {
              setSelectedClient({
                id: contactId,
                name: deal?.contact?.name || deal?.contactName || "Клиент",
                phone: deal?.contact?.phone || null,
                companyName: deal?.contact?.companyName || null,
                dealId: fromDeal,
                inquiryId: deal?.inquiryId || null,
                conversationId: deal?.conversationId || null,
              });
              if (deal?.inquiryId) setInquiryId(deal.inquiryId);
              if (deal?.conversationId) setConversationId(deal.conversationId);
            }
          }
        } catch {
          // keep ids from query even if detail fetch fails
        }
      }

      if (cancelled) return;
      const next = new URLSearchParams(searchParams);
      next.delete("open");
      next.delete("inquiryId");
      next.delete("contactId");
      next.delete("conversationId");
      next.delete("dealId");
      next.delete("command");
      setSearchParams(next, { replace: true });
    }

    void applyDeepLinks();
    return () => {
      cancelled = true;
    };
    // Intentional: consume query once on mount / when params change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    searchParams.get("open"),
    searchParams.get("inquiryId"),
    searchParams.get("contactId"),
    searchParams.get("conversationId"),
    searchParams.get("dealId"),
    searchParams.get("command"),
  ]);

  useEffect(() => {
    if (selectedClient) {
      setSearchHits([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchContacts(searchQ.trim())
        .then((data: any) => setSearchHits(data.clients || []))
        .catch(() => setSearchHits([]));
    }, searchQ.trim() ? 220 : 0);
    return () => clearTimeout(timer);
  }, [searchQ, selectedClient]);

  useEffect(() => {
    if (cmdWhoMode !== "contact") {
      setCmdSearchHits([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchContacts(cmdSearchQ.trim())
        .then((data: any) => setCmdSearchHits(data.clients || []))
        .catch(() => setCmdSearchHits([]));
    }, cmdSearchQ.trim() ? 220 : 0);
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
    if (filter === "done") return isClosedTask(item);
    if (filter === "waiting") return item.status === "waiting";
    if (filter === "scheduled") {
      return (
        !isClosedTask(item) &&
        (isScheduledSend(item) || Boolean(item.dueAt && new Date(item.dueAt).getTime() > now.getTime()))
      );
    }
    if (filter === "overdue") {
      return (
        item.dueAt &&
        new Date(item.dueAt) < now &&
        item.status !== "done" &&
        item.status !== "canceled" &&
        !isScheduledSend(item)
      );
    }
    if (filter === "mine") return item.ownerMembershipId === membershipId && ["open", "waiting"].includes(item.status);
    return item.status === "open";
  });

  const activeItems = visible.filter((item) => !isClosedTask(item));
  const doneItems = visible.filter((item) => isClosedTask(item));
  const groups = ["overdue", "today", "later", "none"].map((key) => ({
    key,
    items: activeItems.filter((item) => dueGroup(item, now) === key),
  }));
  const doneGroups = groupDoneByDate(doneItems, now);
  const showActiveGroups = filter !== "done";
  const showDoneGroups = filter === "done" || filter === "all";

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
        dueAt: dueAt || undefined,
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
    if (String(taskId).startsWith("campaign:")) {
      setError("Это запланированная рассылка. Откройте «Массовая отправка», если нужно изменить её.");
      return;
    }
    setBusy(true);
    setError("");
    setPreview(null);
    setExecResult(null);
    try {
      const detail = await api.task(taskId);
      setActiveTaskId(taskId);
      setTaskDetail(detail);
      setMessageDraft(resolveOutboundDraft(detail));
      setEditDueAt(detail.dueAt ? toDateTimeLocal(new Date(detail.dueAt)) : "");
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
      const contentBase64 = await readFileBase64(file);
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

  async function taskEditPayload() {
    const payload: { messageDraft: string; dueAt?: string } = { messageDraft };
    if (editDueAt) payload.dueAt = editDueAt;
    return payload;
  }

  async function onSaveTaskEdits() {
    if (!activeTaskId) return;
    if (isScheduledSend(taskDetail) && editDueAt && !isFutureDue(editDueAt)) {
      setError("Укажите время в будущем — иначе сообщение уйдёт сразу.");
      return;
    }
    setBusy(true);
    try {
      await api.updateTask(activeTaskId, await taskEditPayload());
      const detail = await api.task(activeTaskId);
      setTaskDetail(detail);
      setMessageDraft(resolveOutboundDraft(detail));
      setEditDueAt(detail.dueAt ? toDateTimeLocal(new Date(detail.dueAt)) : "");
      setPreview(null);
      setError("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить правки");
    } finally {
      setBusy(false);
    }
  }

  async function onPrepare() {
    if (!activeTaskId) return;
    setBusy(true);
    try {
      await api.updateTask(activeTaskId, await taskEditPayload());
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
      if ((result as any).scheduled) {
        setPreview(null);
        setActiveTaskId(null);
        setTaskDetail(null);
        await load();
      } else if ((result as any).success) {
        setNextPanel({ taskId: activeTaskId, actions: (result as any).nextActions || [] });
        setPreview(null);
        setActiveTaskId(null);
        setTaskDetail(null);
        await load();
      } else {
        // Keep editor + confirm panel open for retry; refresh attachment send states.
        if ((result as any).note) setError("");
        const detail = await api.task(activeTaskId);
        setTaskDetail(detail);
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
        setTaskDetail(null);
        await load();
      } else {
        const detail = await api.task(activeTaskId);
        setTaskDetail(detail);
        await load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Повтор не удался");
    } finally {
      setBusy(false);
    }
  }

  async function retryFilesFromList(taskId: string) {
    setBusy(true);
    setError("");
    try {
      const result: any = await api.executeTask(taskId, { retryFailedFilesOnly: true });
      if (result.success) {
        setNextPanel({ taskId, actions: result.nextActions || [] });
        await load();
        return;
      }
      // Open editor with last result so retry stays visible.
      await openTaskEditor(taskId);
      setExecResult(result);
      setPreview({
        actionLabel: "Повтор отправки файла",
        client: { name: "Клиент", phone: null },
        request: null,
        channel: "WhatsApp",
        message: "Текст уже отправлен. Повторяем только файл.",
        attachments: (result.files || []).map((f: any) => ({
          id: f.id,
          fileName: f.fileName,
          documentType: "document",
          sizeLabel: "",
        })),
      });
      await load();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Повтор не удался";
      setError(message);
      if (/подтверд|stale|confirm/i.test(message)) {
        await openTaskEditor(taskId);
      }
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

  async function onCmdAttachFiles(files: FileList | File[]) {
    try {
      const pending = await filesToPending(files);
      setCmdPendingFiles((prev) => [...prev, ...pending].slice(0, 20));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось прочитать файл");
    }
  }

  function onCmdDrop(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer.files?.length) void onCmdAttachFiles(event.dataTransfer.files);
  }

  async function uploadPendingToTask(taskId: string, files: PendingAttachment[]) {
    for (const file of files) {
      await api.addTaskAttachment(taskId, {
        fileName: file.fileName,
        mimeType: file.mimeType,
        contentBase64: file.contentBase64,
        documentType: file.documentType,
      });
    }
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
        pendingAttachments: cmdPendingFiles,
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
      const nextDraft = String(data.suggestedDraft || "").trim();
      setCommandDraft(nextDraft);
      if (data.asCampaign || ((data.clients?.length || 0) + unresolved.length > 5 && massIntent)) {
        setShowCampaignPanel(true);
        setComposeMode("campaign");
        setCampaignSeed({
          whoMode: unresolved.length || hasPhoneBlob ? "phones" : "contacts",
          contactIds: ids,
          phones: unresolved.length ? unresolved.join("\n") : hasPhoneBlob ? commandText : undefined,
          command: commandText,
          message: nextDraft,
          pendingAttachments: cmdPendingFiles,
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
    if (commandDueMode === "scheduled") {
      if (!commandDueAt) {
        setError("Укажите дату и время срока");
        return;
      }
      if (!isFutureDue(commandDueAt)) {
        setError("Укажите время в будущем. Сейчас выбранный срок уже наступил — сообщение уйдёт сразу.");
        return;
      }
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
        dueAt: commandDueMode === "scheduled" && commandDueAt ? commandDueAt : undefined,
      });
      const rootTaskId = created.task?.id as string | undefined;
      if (rootTaskId && cmdPendingFiles.length) {
        const childIds = ((created.task?.childTasks || []) as Array<{ id: string }>).map((c) => c.id);
        // Upload once on parent; API fans out to children for group tasks.
        await uploadPendingToTask(rootTaskId, cmdPendingFiles);
        if (!childIds.length) {
          // single client task — already uploaded to root
        }
        setCmdPendingFiles([]);
      }
      setCommandTaskId(rootTaskId || null);
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
        setCommandDueMode("now");
        setCommandDueAt("");
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
        const result: any = await api.executeTaskBatch(commandTaskId);
        if (result.scheduled) {
          setBatchResult({
            scheduled: true,
            dueAt: result.dueAt,
            message: result.note,
            total: result.total || commandSelectedIds.length,
            success: 0,
            failed: 0,
          });
          setCommandTaskId(null);
        } else {
          setBatchResult(result);
          setNextPanel({
            taskId: commandTaskId,
            actions: result.nextActions || [],
          });
        }
      } else {
        await api.prepareTaskExecution(commandTaskId);
        await api.confirmTaskExecution(commandTaskId);
        const result: any = await api.executeTask(commandTaskId);
        if (result.scheduled) {
          setBatchResult({
            scheduled: true,
            dueAt: result.dueAt,
            message: result.note,
            total: 1,
            success: 0,
            failed: 0,
            taskId: commandTaskId,
          });
          setCommandTaskId(null);
        } else {
          setBatchResult({
            total: 1,
            success: result.success ? 1 : 0,
            failed: result.success ? 0 : 1,
            textOk: result.textOk,
            textError: result.textError,
            files: result.files || [],
            retryFilesAvailable: Boolean(result.retryFilesAvailable),
            taskId: commandTaskId,
          });
          if (result.success && result.nextActions?.length) {
            setNextPanel({ taskId: commandTaskId, actions: result.nextActions });
            setCommandTaskId(null);
          }
        }
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Отправка не удалась");
    } finally {
      setBusy(false);
    }
  }

  async function onRetryCommandFiles() {
    const taskId = batchResult?.taskId || commandTaskId;
    if (!taskId) return;
    setBusy(true);
    try {
      const result: any = await api.executeTask(taskId, { retryFailedFilesOnly: true });
      setBatchResult({
        total: 1,
        success: result.success ? 1 : 0,
        failed: result.success ? 0 : 1,
        textOk: result.textOk ?? true,
        textError: result.textError,
        files: result.files || [],
        retryFilesAvailable: Boolean(result.retryFilesAvailable),
        taskId,
      });
      if (result.success) {
        if (result.nextActions?.length) {
          setNextPanel({ taskId, actions: result.nextActions });
        }
        setCommandTaskId(null);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Повтор отправки файла не удался");
    } finally {
      setBusy(false);
    }
  }

  const filterCounts = {
    open: items.filter((item) => item.status === "open").length,
    waiting: items.filter((item) => item.status === "waiting").length,
    scheduled: items.filter(
      (item) =>
        !isClosedTask(item) &&
        (isScheduledSend(item) || Boolean(item.dueAt && new Date(item.dueAt).getTime() > now.getTime())),
    ).length,
    overdue: items.filter(
      (item) =>
        item.dueAt &&
        new Date(item.dueAt) < now &&
        item.status !== "done" &&
        item.status !== "canceled" &&
        !isScheduledSend(item),
    ).length,
    mine: items.filter((item) => item.ownerMembershipId === membershipId && ["open", "waiting"].includes(item.status)).length,
    done: items.filter((item) => isClosedTask(item)).length,
    all: items.length,
  };
  const commandWillSchedule = commandDueMode === "scheduled" && Boolean(commandDueAt);

  return (
    <section>
      <div className="page-head">
        <div>
          <p className="page-kicker">Операции</p>
          <h2>Задачи</h2>
        </div>
        <div className="actions">
          <button
            type="button"
            className={showCreate && composeMode === "command" ? "btn" : "btn secondary"}
            {...tip("Опишите задачу своими словами — система разберёт, кому и что отправить")}
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
            className={showCreate && (composeMode === "campaign" || showCampaignPanel) ? "btn" : "btn secondary"}
            {...tip("Рассылка одного сообщения или файла списку номеров / сегменту CRM")}
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
            className={showCreate && composeMode === "manual" ? "btn" : "btn secondary"}
            {...tip("Создать задачу вручную: тип, клиент, срок, текст")}
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
            ["scheduled", "Запланировано"],
            ["overdue", "Просроченные"],
            ["mine", "Мои"],
            ["done", "Сделанные"],
            ["all", "Все"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            className={filter === value ? "btn" : "btn secondary"}
            {...tip(
              value === "open"
                ? "Задачи в работе прямо сейчас"
                : value === "waiting"
                  ? "Ждёте ответа клиента или внешней реакции"
                  : value === "scheduled"
                    ? "Отправка в выбранное время, не сразу"
                    : value === "overdue"
                    ? "Срок уже прошёл — нужно действие"
                    : value === "mine"
                      ? "Назначены на вас"
                      : value === "done"
                        ? "Что уже сделано, по датам"
                        : "Все задачи: сначала работа, затем сделанное по датам",
            )}
            onClick={() => setFilter(value)}
          >
            {label} · {filterCounts[value]}
          </button>
        ))}
      </div>

      {whatsappReady === false ? (
        <div className="banner warn">
          <span>
            WhatsApp-бот не подключён или недоступен. Создавать и закрывать задачи можно, а отправка сообщений/КП из задачи —
            только после подключения в{" "}
            <Link to="/integrations">Интеграциях</Link>. Для рассылки по списку номеров используйте «Массовая отправка».
          </span>
        </div>
      ) : null}

      {showCreate && (composeMode === "campaign" || showCampaignPanel) ? (
        <CampaignMassPanel
          key={`${campaignSeed.whoMode || "phones"}-${(campaignSeed.contactIds || []).join(",")}-${(campaignSeed.phones || "").slice(0, 40)}`}
          initialPhoneText={campaignSeed.phones || ""}
          initialContactIds={campaignSeed.contactIds || []}
          initialSegment={campaignSeed.segment}
          initialMessage={campaignSeed.message || ""}
          commandText={campaignSeed.command || commandText}
          initialWhoMode={campaignSeed.whoMode}
          initialPendingAttachments={campaignSeed.pendingAttachments || []}
          onClose={() => {
            setShowCampaignPanel(false);
            setComposeMode("command");
            setCampaignSeed({});
          }}
          onScheduled={() => {
            setFilter("scheduled");
            setShowCampaignPanel(false);
            setComposeMode("command");
            setCampaignSeed({});
            void load();
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
                        pendingAttachments: cmdPendingFiles,
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
                  Найти или выбрать клиента
                  <input
                    value={cmdSearchQ}
                    onChange={(event) => setCmdSearchQ(event.target.value)}
                    placeholder="Имя, телефон или компания"
                    autoComplete="off"
                  />
                </label>
                {cmdSearchHits.length > 0 ? (
                  <>
                    <div className="muted" style={{ marginTop: 8 }}>
                      {cmdSearchQ.trim()
                        ? `Найдено: ${cmdSearchHits.length}`
                        : "Клиенты CRM — нажмите, чтобы выбрать"}
                    </div>
                    <div className="picker-list" role="listbox" aria-label="Клиенты CRM">
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
                              setCommandParse(null);
                              setError("");
                            }}
                          >
                            <b>{hit.name}</b>
                            <div className="muted">
                              {[hit.phone, hit.companyName, hit.interest, hit.statusLabel]
                                .filter(Boolean)
                                .join(" · ")}
                              {already ? " · уже выбран" : ""}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </>
                ) : cmdSearchQ.trim() ? (
                  <p className="muted">Никого не нашли. Попробуйте другой запрос или режим «По номеру».</p>
                ) : (
                  <p className="muted">Загрузка клиентов…</p>
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
              placeholder="Любая задача своими словами: попросить реквизиты, согласовать макет, напомнить про оплату…"
            />
            <p className="muted">Пишите как есть. ИИ соберёт текст клиенту из вашей команды и заявки — не из готовых шаблонов.</p>
          </div>

          <div
            className="command-step"
            onDragOver={(event) => event.preventDefault()}
            onDrop={onCmdDrop}
          >
            <div className="command-step-label">
              3. Вложения{cmdPendingFiles.length ? ` · ${cmdPendingFiles.length}` : ""}
            </div>
            <div className="actions">
              <label className="btn secondary">
                + Файл
                <input
                  type="file"
                  hidden
                  multiple
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.webp,.txt,.zip,application/pdf,image/*"
                  onChange={(event) => event.target.files && void onCmdAttachFiles(event.target.files)}
                />
              </label>
              <label className="btn secondary">
                + Документ
                <input
                  type="file"
                  hidden
                  multiple
                  accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                  onChange={(event) => event.target.files && void onCmdAttachFiles(event.target.files)}
                />
              </label>
              <label className="btn secondary">
                + Фото
                <input
                  type="file"
                  hidden
                  multiple
                  accept=".jpg,.jpeg,.png,.webp,image/*"
                  onChange={(event) => event.target.files && void onCmdAttachFiles(event.target.files)}
                />
              </label>
            </div>
            <p className="muted">Перетащите файлы сюда. PDF, DOC/X, XLS/X, PPT/X, JPG/PNG/WEBP — как в рассылке.</p>
            {cmdPendingFiles.length ? (
              <div className="picker-list">
                {cmdPendingFiles.map((file) => (
                  <div key={file.localId} className="picker-item">
                    <div>
                      <b>{file.fileName}</b>
                      <div className="muted">
                        {formatBytes(file.sizeBytes)} · {file.documentType}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => setCmdPendingFiles((prev) => prev.filter((item) => item.localId !== file.localId))}
                    >
                      Удалить
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="command-step">
            <div className="command-step-label">4. Срок исполнения</div>
            <div className="segmented">
              <button
                type="button"
                className={commandDueMode === "now" ? "btn" : "btn secondary"}
                onClick={() => setCommandDueMode("now")}
              >
                Сейчас
              </button>
              <button
                type="button"
                className={commandDueMode === "scheduled" ? "btn" : "btn secondary"}
                onClick={() => {
                  setCommandDueMode("scheduled");
                  if (!commandDueAt) {
                    setCommandDueAt(toDateTimeLocal(new Date(Date.now() + 60 * 60 * 1000)));
                  }
                }}
              >
                По дате и времени
              </button>
            </div>
            {commandDueMode === "scheduled" ? (
              <>
                <label>
                  Когда выполнить
                  <input
                    type="datetime-local"
                    value={commandDueAt}
                    onChange={(event) => setCommandDueAt(event.target.value)}
                  />
                </label>
                <p className="muted">
                  Задача сразу попадёт в «Запланировано». После подтверждения CRM отправит сообщение в это время, не раньше.
                </p>
              </>
            ) : (
              <p className="muted">Задача появится сразу в открытых. После подтверждения CRM отправит сообщение сейчас.</p>
            )}
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
                setCommandDueMode("now");
                setCommandDueAt("");
                setCommandParse(null);
                setCmdSelectedContacts([]);
                setCmdPhones([]);
                setCmdPhoneDraft("");
                setCmdPhoneNameDraft("");
                setCmdPhonesUnresolved([]);
                setBatchResult(null);
                setCommandTaskId(null);
                setCmdPendingFiles([]);
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
                  <b>
                    {commandDueMode === "scheduled" && commandDueAt
                      ? formatDateTimeLocalInput(commandDueAt)
                      : commandParse.understanding?.when || "Сейчас"}
                  </b>
                </div>
              </div>
              <p className="muted">
                {commandParse.command?.intent === "document_action"
                  ? commandParse.understanding?.consequence
                  : commandWillSchedule
                  ? "После подтверждения CRM поставит задачу в «Запланировано» и отправит сообщение в указанное время, не сразу."
                  : commandParse.understanding?.consequence}
              </p>
              {commandParse.command?.intent === "document_action" ? (
                <div className="panel soft" style={{ marginTop: 12 }}>
                  <b>Это команда по документам</b>
                  <p className="muted">WhatsApp-задачу не создаём.</p>
                  {(commandParse.document?.deals || []).map((deal: { id: string; title: string; href: string }) => (
                    <div key={deal.id}>
                      <Link to={deal.href}>{deal.title}</Link>
                    </div>
                  ))}
                  <Link className="btn" to={`/documents?command=${encodeURIComponent(commandText)}`}>
                    Открыть в Документах
                  </Link>
                </div>
              ) : null}

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

              {commandParse.command?.intent !== "document_action" &&
              (commandParse.command?.riskLevel >= 3 ||
                commandParse.command?.taskType === "proposal" ||
                commandParse.command?.taskType === "message" ||
                commandDraft) ? (
                <label>
                  Сообщение клиенту
                  <textarea value={commandDraft} onChange={(event) => setCommandDraft(event.target.value)} rows={3} />
                  <span className="muted">ИИ составил из вашей команды. Можно править перед постановкой.</span>
                </label>
              ) : null}

              {cmdPendingFiles.length ? (
                <p className="muted">К задаче будет прикреплено файлов: {cmdPendingFiles.length}</p>
              ) : null}

              <div className="actions">
                <button type="button" className="btn secondary" onClick={() => setCommandParse(null)}>
                  Изменить
                </button>
                {commandParse.command?.intent !== "document_action" ? (
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
                ) : null}
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
                      {commandWillSchedule ? "Запланировать отправку" : "Подтвердить и отправить"}
                    </button>
                  </div>
                </div>
              ) : null}

              {batchResult ? (
                <div className="panel soft" style={{ marginTop: 12 }}>
                  {batchResult.scheduled ? (
                    <>
                      <b>Запланировано</b>
                      <p>
                        {batchResult.dueAt
                          ? `Отправка запланирована на ${formatDateTimeRu(batchResult.dueAt)}. Задача остаётся в «Запланировано».`
                          : batchResult.message || "Задача остаётся в «Запланировано»."}
                      </p>
                    </>
                  ) : batchResult.prepareOnly ? (
                    <p>{batchResult.message}</p>
                  ) : (
                    <>
                      <b>Выполнено</b>
                      <p>
                        Успешно: {batchResult.success} · Ошибка: {batchResult.failed} · Всего: {batchResult.total}
                      </p>
                      {batchResult.textOk === false ? (
                        <p className="error">Текст не отправлен: {batchResult.textError || "ошибка"}</p>
                      ) : batchResult.textOk ? (
                        <p className="muted">Текст отправлен ✓</p>
                      ) : null}
                      {(batchResult.files || []).map((f: any) => (
                        <p key={f.id || f.fileName} className={f.ok ? "muted" : "error"}>
                          {f.fileName}: {f.ok ? "✓" : `✕ ${f.error || "ошибка"}`}
                        </p>
                      ))}
                      {batchResult.retryFilesAvailable ? (
                        <div className="actions" style={{ marginTop: 8 }}>
                          <button type="button" className="btn" disabled={busy} onClick={onRetryCommandFiles}>
                            Повторить отправку файла
                          </button>
                        </div>
                      ) : null}
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
            {CREATE_TASK_TYPES.map(([id, label]) => (
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
                Найти или выбрать клиента
                <input
                  value={searchQ}
                  onChange={(event) => setSearchQ(event.target.value)}
                  placeholder="Имя, телефон, компания"
                  autoComplete="off"
                />
              </label>
            ) : null}
            {!selectedClient && searchHits.length > 0 ? (
              <>
                <div className="muted" style={{ marginTop: 8 }}>
                  {searchQ.trim() ? `Найдено: ${searchHits.length}` : "Клиенты CRM — нажмите, чтобы выбрать"}
                </div>
                <div className="picker-list" role="listbox" aria-label="Клиенты CRM">
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
                        {[hit.phone, hit.companyName, hit.interest, hit.statusLabel].filter(Boolean).join(" · ")}
                      </div>
                      {hit.lastContactLabel ? <div className="muted">Последний контакт: {hit.lastContactLabel}</div> : null}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
            {!selectedClient && !searchHits.length ? (
              <p className="muted">{searchQ.trim() ? "Никого не нашли." : "Загрузка клиентов…"}</p>
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
          <b>{isScheduledSend(taskDetail) ? "Изменить запланированную задачу" : "Подготовка отправки"}</b>
          <div className="muted">{taskDetail.title}</div>
          {isScheduledSend(taskDetail) ? (
            <p className="muted">
              Сохраните правки — задача останется в «Запланировано», сообщение уйдёт в указанное время, не сразу.
            </p>
          ) : null}
          {taskDetail.briefing ? (
            <div className="task-briefing-card">
              {taskDetail.briefing.basisLabel ? <div className="muted">{taskDetail.briefing.basisLabel}</div> : null}
              {taskDetail.briefing.client ? (
                <div>
                  <span className="muted">Клиент</span>
                  <div>
                    {nameWithPhone(taskDetail.briefing.client.name, taskDetail.briefing.client.phone)}
                    {taskDetail.briefing.client.companyName ? ` · ${taskDetail.briefing.client.companyName}` : ""}
                  </div>
                </div>
              ) : null}
              {taskDetail.briefing.purpose ? (
                <div>
                  <span className="muted">Цель</span>
                  <div>{taskDetail.briefing.purpose}</div>
                </div>
              ) : null}
              {taskDetail.briefing.briefingText ? (
                <div>
                  <span className="muted">Перед встречей</span>
                  <div>{taskDetail.briefing.briefingText}</div>
                </div>
              ) : null}
              {(taskDetail.briefing.preparationHints || []).length ? (
                <div>
                  <span className="muted">Что подготовить</span>
                  <ul>
                    {taskDetail.briefing.preparationHints.map((h: string) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {(taskDetail.briefing.sourceMessages || []).length ? (
                <div>
                  <span className="muted">Последняя переписка</span>
                  <div className="picker-list">
                    {taskDetail.briefing.sourceMessages.map((m: any) => (
                      <div key={m.id} className="picker-item">
                        <b>{m.actorLabel}</b>
                        <div className="muted">{m.text}</div>
                      </div>
                    ))}
                  </div>
                  {taskDetail.briefing.conversationId ? (
                    <Link to={`/conversations/${taskDetail.briefing.conversationId}`}>Открыть весь диалог</Link>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
          <label>
            Сообщение
            <textarea value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} rows={5} />
          </label>
          <label>
            Когда выполнить
            <input type="datetime-local" value={editDueAt} onChange={(event) => setEditDueAt(event.target.value)} />
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
            <button
              type="button"
              className="btn secondary"
              {...tip("Закрыть панель без отправки")}
              onClick={() => { setActiveTaskId(null); setTaskDetail(null); setEditDueAt(""); }}
            >
              Закрыть
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy}
              {...tip("Сохранить текст и срок. Если отправка уже запланирована, она перенесётся на новое время")}
              onClick={() => void onSaveTaskEdits()}
            >
              Сохранить правки
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              {...tip("Проверить канал и показать подтверждение перед отправкой в WhatsApp")}
              onClick={onPrepare}
            >
              Подготовить отправку
            </button>
          </div>
          <p className="muted" style={{ marginTop: 8 }}>
            Отправка идёт через WhatsApp-диалог клиента (sellerLead). Если диалога нет — сначала синхронизируйте бота в Интеграциях
            или используйте «Массовая отправка» по номеру.
          </p>
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
            <div className={(execResult as any).partial || (execResult as any).textOk ? "task-partial" : "error"}>
              {(execResult as any).note ? <div>{(execResult as any).note}</div> : null}
              <div>
                {(execResult as any).textOk ? "Сообщение отправлено ✓" : "Сообщение не отправлено ✕"}
                {(execResult as any).textError ? ` · ${(execResult as any).textError}` : ""}
              </div>
              {(execResult as any).files?.map((f: any) => (
                <div key={f.id}>
                  {f.fileName}: {f.ok ? "✓" : `✕ ${f.error || ""}`}
                </div>
              ))}
              {(execResult as any).retryFilesAvailable ? (
                <div className="muted" style={{ marginTop: 6 }}>
                  Задача остаётся открытой, пока файл не уйдёт.
                </div>
              ) : null}
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
                {preview.scheduled || isFutureDue(taskDetail?.dueAt)
                  ? "Запланировать отправку"
                  : preview.buttons?.confirm || "Подтвердить и отправить"}
              </button>
            )}
          </div>
        </div>
      ) : null}

      {nextPanel ? (
        <div className="panel task-form">
          <b>Что дальше?</b>
          <p className="muted">
            {nextPanel.note || "Задача выполнена. Подтвердите следующий шаг — AI только предлагает."}
          </p>
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
                {action.requiresConfirm ? " · нужно подтверждение" : ""}
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
            <select
              value={resultCode}
              onChange={(event) => setResultCode(event.target.value)}
            >
              {completeTaskType === "meeting" || completeTaskType === "call" ? (
                <>
                  <option value="agreed">Договорились</option>
                  <option value="needs_estimate">Нужен расчёт</option>
                  <option value="send_proposal">Отправить КП</option>
                  <option value="send_contract">Отправить договор</option>
                  <option value="client_thinking">Клиент думает</option>
                  <option value="callback_later">Перезвонить</option>
                  <option value="reschedule">Перенести встречу</option>
                  <option value="reached">Дозвонился / состоялось</option>
                  <option value="no_answer">Не ответил / не состоялось</option>
                  <option value="refused">Отказ</option>
                  <option value="other">Другое</option>
                </>
              ) : (
                <>
                  <option value="reached">Дозвонился</option>
                  <option value="no_answer">Не ответил</option>
                  <option value="callback_later">Перезвонить позже</option>
                  <option value="refused">Клиент отказался</option>
                  <option value="agreed">Договорились</option>
                  <option value="other">Другое</option>
                </>
              )}
            </select>
          </label>
          <label>
            Комментарий
            <textarea
              rows={3}
              value={resultText}
              onChange={(event) => setResultText(event.target.value)}
              placeholder="Например: обсудили структуру, клиент попросил финальное КП завтра до обеда"
            />
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
                  .completeTaskResult(completeOpen, { resultCode, resultText: resultText || undefined })
                  .then((data: any) => {
                    setCompleteOpen(null);
                    setResultText("");
                    setNextPanel({
                      taskId: completeOpen,
                      actions: data.suggestedNextActions || data.aiSuggestion?.items || [],
                      note: data.aiSuggestion?.note,
                    });
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
              : filter === "scheduled"
                ? "Запланированных задач нет. Выберите «По дате и времени», чтобы отправка ушла не сразу."
                : filter === "overdue"
                ? "Просроченных задач нет."
                : filter === "mine"
                  ? "У вас нет активных задач."
                  : filter === "done"
                    ? "Сделанных задач пока нет."
                    : "Задач пока нет."}
        </p>
      ) : null}

      {showActiveGroups
        ? groups.map((group) =>
        group.items.length === 0 ? null : (
          <div key={group.key}>
            <h3>{GROUP_TITLE[group.key]}</h3>
            {group.items.map((item) => (
              <div className={`row task-row${item.overdue ? " task-row-overdue" : ""}`} key={item.id}>
                <div className="task-row-main">
                  <div className="task-row-title">
                    <b>{item.title}</b>
                    {item.overdue && !isScheduledSend(item) ? <span className="deal-flag">Просрочено</span> : null}
                    {isScheduledSend(item) ? <span className="deal-flag">Отправка запланирована</span> : null}
                    {item.executionStatus === "failed" && !isScheduledSend(item) ? (
                      <span className="deal-flag">Отправка не удалась</span>
                    ) : null}
                    {item.campaignId ? <span className="deal-flag">Рассылка</span> : null}
                  </div>
                  <div className="task-meta-grid">
                    <div>
                      <span className="muted">Тип</span>
                      <div>{item.typeLabel || TASK_TYPES.find(([id]) => id === item.type)?.[1] || item.type}</div>
                    </div>
                    <div>
                      <span className="muted">Статус</span>
                      <div>{item.statusLabel || item.status}</div>
                    </div>
                    <div>
                      <span className="muted">Срок</span>
                      <div>{item.dueAt ? formatDateTimeRu(item.dueAt) : "Без срока"}</div>
                    </div>
                    <div>
                      <span className="muted">Ответственный</span>
                      <div>{item.assigneeName || item.owner?.user?.name || "Не назначен"}</div>
                    </div>
                  </div>
                  <div className="task-who">
                    <span className="muted">Кому</span>
                    <div>
                      {item.targetType === "group" ? (
                        <>
                          Группа
                          {item.progress ? ` · выполнено ${item.progress.label}` : ""}
                          {(item.segmentSnapshotJson as any)?.label
                            ? ` · ${(item.segmentSnapshotJson as any).label}`
                            : item.contextLabel
                              ? ` · ${item.contextLabel}`
                              : ""}
                        </>
                      ) : item.contact?.id || item.whoName ? (
                        <>
                          {item.contact?.id ? (
                            <Link to={`/contacts/${item.contact.id}`}>
                              {item.whoName ||
                                item.contact.name ||
                                [item.contact.firstName, item.contact.lastName].filter(Boolean).join(" ") ||
                                "Клиент"}
                            </Link>
                          ) : (
                            <b>{item.whoName || "Клиент"}</b>
                          )}
                          <span className="muted"> · {phoneText(item.whoPhone)}</span>
                        </>
                      ) : (
                        <span className="muted">{item.contextLabel || "Без привязки к клиенту"}</span>
                      )}
                    </div>
                  </div>
                  {(item.aboutLines || []).length ? (
                    <div className="task-about">
                      <span className="muted">По поводу</span>
                      <ul>
                        {(item.aboutLines as string[]).map((line: string) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                      <div className="task-about-links">
                        {item.inquiryId ? <Link to={`/requests/${item.inquiryId}`}>Открыть заявку</Link> : null}
                        {item.dealId ? <Link to={`/deals/${item.dealId}`}>Открыть сделку</Link> : null}
                        {item.conversationId ? (
                          <Link to={`/conversations/${item.conversationId}`}>Открыть диалог</Link>
                        ) : null}
                        {(item.contactId || item.contact?.id) ? (
                          <Link to={`/contacts/${item.contactId || item.contact.id}`}>Карточка клиента</Link>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                  {item.descriptionPreview ? (
                    <div className="task-desc muted">Описание: {item.descriptionPreview}</div>
                  ) : null}
                  {item.messagePreview ? (
                    <div className="task-desc muted">Сообщение: {item.messagePreview}</div>
                  ) : null}
                  {item.briefingText || item.purpose || item.source === "context_engine" ? (
                    <div className="task-briefing">
                      {item.purpose ? (
                        <div>
                          <span className="muted">Цель</span>
                          <div>{item.purpose}</div>
                        </div>
                      ) : null}
                      {item.briefingText ? (
                        <div>
                          <span className="muted">Перед контактом</span>
                          <div>{item.briefingText}</div>
                        </div>
                      ) : null}
                      {item.source === "context_engine" ? (
                        <div className="muted">Основание: создано автоматически из договорённости в WhatsApp</div>
                      ) : null}
                      {item.commandStatus === "needs_confirmation" ? (
                        <div className="warn-text">Нужно подтверждение перед внешней отправкой</div>
                      ) : null}
                      {item.conversationId ? (
                        <Link to={`/conversations/${item.conversationId}`}>Открыть весь диалог</Link>
                      ) : null}
                      <button
                        type="button"
                        className="btn secondary"
                        {...tip("Показать цель, что известно и черновик сообщения клиенту")}
                        onClick={() => openTaskEditor(item.id)}
                      >
                        Брифинг и сообщение
                      </button>
                    </div>
                  ) : null}
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
                                {nameWithPhone(child.contactName, child.phone)}
                              </b>
                              <div className="muted">{child.statusLabel || child.status}</div>
                              <div className="actions" style={{ marginTop: 6 }}>
                                {child.contactId ? (
                                  <Link className="btn secondary" to={`/contacts/${child.contactId}`}>
                                    Клиент
                                  </Link>
                                ) : null}
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
                  {item.needsFileRetry ? (
                    <div className="task-partial-inline">
                      <span>Текст ушёл · файл не отправлен</span>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        onClick={() => void retryFilesFromList(item.id)}
                      >
                        Повторить файл
                      </button>
                    </div>
                  ) : null}
                  {item.status === "open" || item.status === "waiting" ? (
                    <>
                      {String(item.id).startsWith("campaign:") ? (
                        <span className="muted">Отправка уйдёт в срок рассылки</span>
                      ) : (
                      <button
                        className={isScheduledSend(item) ? "btn" : "btn secondary"}
                        type="button"
                        {...tip(
                          isScheduledSend(item)
                            ? "Изменить текст или время отправки. Сообщение не уйдёт сразу"
                            : "Изменить текст, срок или черновик задачи",
                        )}
                        onClick={() => openTaskEditor(item.id)}
                      >
                        Изменить
                      </button>
                      )}
                      {SENDABLE.has(item.type) && item.targetType !== "group" && !isScheduledSend(item) ? (
                        <button
                          className="btn"
                          type="button"
                          {...tip(
                            item.needsFileRetry
                              ? "Открыть задачу, чтобы повторить отправку файла"
                              : "Открыть черновик и отправить сообщение/файл клиенту в WhatsApp",
                          )}
                          onClick={() => openTaskEditor(item.id)}
                        >
                          {item.needsFileRetry ? "Открыть задачу" : "Подготовить отправку"}
                        </button>
                      ) : null}
                      {SENDABLE.has(item.type) && item.targetType === "group" && !item.campaignId ? (
                        <button
                          className="btn"
                          type="button"
                          {...tip("Открыть массовую рассылку по клиентам этой групповой задачи")}
                          onClick={() => {
                            const ids = (item.children || [])
                              .map((child: any) => child.contactId)
                              .filter(Boolean);
                            if (!ids.length) {
                              setError("В группе нет клиентов для рассылки");
                              return;
                            }
                            setComposeMode("campaign");
                            setShowCampaignPanel(true);
                            setShowCreate(true);
                            setCampaignSeed({
                              whoMode: "contacts",
                              contactIds: ids,
                              message: item.messageDraft || "",
                              command: item.title,
                            });
                          }}
                        >
                          Массовая отправка группе
                        </button>
                      ) : null}
                      {MANUAL_COMPLETE.has(item.type) ? (
                        <button
                          className="btn secondary"
                          type="button"
                          {...tip("Закрыть задачу с результатом (дозвон, итог встречи и т.п.) и получить следующий шаг")}
                          onClick={() => {
                            setCompleteOpen(item.id);
                            setCompleteTaskType(item.type);
                            setResultCode(item.type === "meeting" || item.type === "call" ? "agreed" : "reached");
                            setResultText("");
                          }}
                        >
                          С результатом
                        </button>
                      ) : null}
                      {item.status === "open" ? (
                        <button
                          className="btn secondary"
                          {...tip("Отложить: ждёте ответа клиента. Задача уйдёт во вкладку «Жду»")}
                          onClick={() => api.waitTask(item.id).then(load).catch((err) => setError(err.message))}
                        >
                          Жду ответа
                        </button>
                      ) : null}
                      {item.status === "waiting" ? (
                        <button
                          className="btn secondary"
                          {...tip("Вернуть задачу из ожидания обратно в открытые")}
                          onClick={() => api.reopenTask(item.id).then(load).catch((err) => setError(err.message))}
                        >
                          Вернуть в работу
                        </button>
                      ) : null}
                      <button
                        className="btn secondary"
                        type="button"
                        {...tip("Сразу отметить задачу выполненной без заполнения результата")}
                        onClick={() =>
                          api
                            .completeTask(item.id)
                            .then(load)
                            .catch((err) => setError(err instanceof Error ? err.message : "Нельзя закрыть"))
                        }
                      >
                        Готово
                      </button>
                      <button
                        className="btn danger"
                        {...tip("Отменить задачу — она больше не будет в работе")}
                        onClick={() => api.cancelTask(item.id).then(load).catch((err) => setError(err.message))}
                      >
                        Отменить
                      </button>
                    </>
                  ) : (
                    <span className="muted">{item.statusLabel || item.status}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        ),
      )
        : null}

      {showDoneGroups && doneGroups.length ? (
        <div className="task-done-log">
          {filter === "all" && activeItems.length ? <h3>Уже сделано</h3> : null}
          {doneGroups.map((group) => (
            <div key={`done-${group.key}`}>
              <h3 className={filter === "all" && activeItems.length ? "task-done-date" : undefined}>{group.title}</h3>
              {group.items.map((item) => {
                const result = taskResultLine(item);
                const when = taskDoneAt(item);
                return (
                  <div className={`row task-row task-row-done${item.status === "canceled" ? " task-row-canceled" : ""}`} key={item.id}>
                    <div className="task-row-main">
                      <div className="task-row-title">
                        <b>{item.title}</b>
                        <span className={`deal-flag ${item.status === "canceled" ? "" : "deal-flag-done"}`}>
                          {item.status === "canceled" ? "Отменена" : "Сделано"}
                        </span>
                      </div>
                      <div className="task-meta-grid">
                        <div>
                          <span className="muted">Тип</span>
                          <div>{item.typeLabel || TASK_TYPES.find(([id]) => id === item.type)?.[1] || item.type}</div>
                        </div>
                        <div>
                          <span className="muted">Результат</span>
                          <div>{result || item.statusLabel || "Сделано"}</div>
                        </div>
                        <div>
                          <span className="muted">Когда</span>
                          <div>
                            {when.getTime()
                              ? when.toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
                              : "—"}
                          </div>
                        </div>
                        <div>
                          <span className="muted">Ответственный</span>
                          <div>{item.assigneeName || item.owner?.user?.name || "Не назначен"}</div>
                        </div>
                      </div>
                      <div className="task-who">
                        <span className="muted">Кому</span>
                        <div>
                          {item.contact?.id || item.whoName ? (
                            <>
                              {item.contact?.id ? (
                                <Link to={`/contacts/${item.contact.id}`}>
                                  {item.whoName || item.contact.name || "Клиент"}
                                </Link>
                              ) : (
                                <b>{item.whoName || "Клиент"}</b>
                              )}
                              <span className="muted"> · {phoneText(item.whoPhone)}</span>
                            </>
                          ) : (
                            <span className="muted">{item.contextLabel || "Без привязки к клиенту"}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
