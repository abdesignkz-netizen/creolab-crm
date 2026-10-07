import { InlineFeedback } from "../components/InlineFeedback";
import { uiText, useUiText, localizeUiOptions, uiMessage, uiFormatLocale } from "../lib/uiText";
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { nameWithPhone } from "../lib/contactDisplay";
import { api } from "../lib/api";

type PickerClient = {
  id: string;
  name: string;
  phone: string | null;
  companyName?: string | null;
  interest?: string | null;
  statusLabel?: string | null;
};

type PhoneItem = {
  raw: string;
  status: "ok_existing" | "ok_new" | "invalid" | "duplicate";
  phoneRaw?: string;
  phoneNormalized?: string;
  contactId?: string | null;
  displayName?: string | null;
  interest?: string | null;
  companyName?: string | null;
  reason?: string;
};

type SegmentBody = Record<string, unknown>;

const QUICK_SEGMENTS = [
  { id: "today", label: "Новые сегодня", body: { datePreset: "today", dateField: "lastContact" } },
  { id: "week", label: "За 7 дней", body: { datePreset: "last_7_days" } },
  { id: "month", label: "За 30 дней", body: { datePreset: "last_30_days" } },
  { id: "web", label: "Сайты", body: { serviceCategories: ["WEB"] } },
  { id: "pres", label: "Презентации", body: { serviceCategories: ["PRESENTATION"] } },
  { id: "ads", label: "Реклама", body: { serviceCategories: ["ADVERTISING"] } },
  { id: "reply", label: "Ждут ответа", body: { needsReply: true } },
  { id: "nowin", label: "Без продажи", body: { excludeWon: true, datePreset: "last_30_days" } },
] as const;

const MAP_FIELDS = [
  ["phone", "Телефон"],
  ["name", "Имя"],
  ["company", "Компания"],
  ["email", "Email"],
  ["service", "Интерес / услуга"],
  ["comment", "Комментарий"],
  ["skip", "Пропустить"],
] as const;

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function toDateTimeLocal(value: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function parseScheduleDate(raw: string, input?: HTMLInputElement | null): Date | null {
  const value = String(raw || input?.value || "").trim();
  const fromLocal = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(value);
  if (fromLocal) {
    const date = new Date(
      Number(fromLocal[1]),
      Number(fromLocal[2]) - 1,
      Number(fromLocal[3]),
      Number(fromLocal[4]),
      Number(fromLocal[5]),
      Number(fromLocal[6] || 0),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const fromRu = /^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[,\s]+(\d{1,2}):(\d{2}))?/.exec(value);
  if (fromRu) {
    const date = new Date(
      Number(fromRu[3]),
      Number(fromRu[2]) - 1,
      Number(fromRu[1]),
      Number(fromRu[4] || 0),
      Number(fromRu[5] || 0),
    );
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (input && Number.isFinite(input.valueAsNumber) && input.valueAsNumber > 0) {
    const date = new Date(input.valueAsNumber);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function readFileBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    };
    reader.onerror = () => reject(new Error(uiText("Не удалось прочитать файл")));
    reader.readAsDataURL(file);
  });
}

function guessMimeType(file: File) {
  const raw = String(file.type || "").trim();
  if (raw && raw !== "application/octet-stream" && raw !== "binary/octet-stream") return raw;
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".doc")) return "application/msword";
  if (name.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (name.endsWith(".xls")) return "application/vnd.ms-excel";
  if (name.endsWith(".xlsx")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (name.endsWith(".ppt")) return "application/vnd.ms-powerpoint";
  if (name.endsWith(".pptx")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".txt")) return "text/plain";
  if (name.endsWith(".zip")) return "application/zip";
  return raw || "application/octet-stream";
}

export function CampaignMassPanel({
  initialPhoneText = "",
  initialContactIds = [],
  initialSegment,
  initialMessage = "",
  commandText = "",
  initialWhoMode,
  initialPendingAttachments = [],
  onClose,
  onScheduled,
}: {
  initialPhoneText?: string;
  initialContactIds?: string[];
  initialSegment?: SegmentBody;
  initialMessage?: string;
  commandText?: string;
  initialWhoMode?: "contacts" | "phones" | "segment" | "import";
  initialPendingAttachments?: Array<{
    fileName: string;
    mimeType: string;
    contentBase64: string;
    documentType: string;
    sizeBytes?: number;
  }>;
  onClose?: () => void;
  onScheduled?: (info: { dueAt: string; recipients: number; title: string }) => void;
}) {
  const uiText = useUiText();
  const [whoMode, setWhoMode] = useState<"contacts" | "phones" | "segment" | "import">(
    initialWhoMode || (initialContactIds.length ? "contacts" : initialSegment ? "segment" : "phones"),
  );
  const [phoneText, setPhoneText] = useState(initialPhoneText);
  const [phonePreview, setPhonePreview] = useState<{ items: PhoneItem[]; summary: any } | null>(null);
  const [excludedRaws, setExcludedRaws] = useState<string[]>([]);
  const [message, setMessage] = useState(initialMessage);
  const [messageMode, setMessageMode] = useState<"manual" | "ai" | "file_only">("manual");
  const [personalizeEach, setPersonalizeEach] = useState(Boolean(commandText));
  const [createMissing, setCreateMissing] = useState(true);
  const [whenMode, setWhenMode] = useState<"now" | "schedule">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const scheduleInputRef = useRef<HTMLInputElement>(null);
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [campaign, setCampaign] = useState<any>(null);
  const [prepare, setPrepare] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState<{ title: string; text: string; kind: "prepare" | "scheduled" | "sent" } | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const [showAll, setShowAll] = useState(false);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [queuedUploads, setQueuedUploads] = useState(initialPendingAttachments);
  const [contactIds, setContactIds] = useState(initialContactIds);
  const [selectedContacts, setSelectedContacts] = useState<PickerClient[]>([]);
  const [searchQ, setSearchQ] = useState("");
  const [searchHits, setSearchHits] = useState<PickerClient[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [segment, setSegment] = useState<SegmentBody | null>(initialSegment || null);
  const [segmentPreview, setSegmentPreview] = useState<{ total: number; clients: any[] } | null>(null);
  const [importPreview, setImportPreview] = useState<any>(null);
  const [importMapping, setImportMapping] = useState<Record<string, string>>({});
  const [importFileMeta, setImportFileMeta] = useState<{ fileName: string; contentBase64: string } | null>(null);

  const scheduleMin = useMemo(() => toDateTimeLocal(new Date()), []);
  const validPhones = useMemo(
    () =>
      (phonePreview?.items || []).filter(
        (item) => (item.status === "ok_existing" || item.status === "ok_new") && !excludedRaws.includes(item.raw),
      ),
    [phonePreview, excludedRaws],
  );

  async function parsePhones(text = phoneText) {
    setBusy(true);
    try {
      const data: any = await api.parsePhoneList(text);
      setPhonePreview(data);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось разобрать номера"));
    } finally {
      setBusy(false);
    }
  }

  async function runSegment(body: SegmentBody, merge = true) {
    setBusy(true);
    try {
      const next = merge ? { ...(segment || {}), ...body } : body;
      setSegment(next);
      const data: any = await api.segmentPreview({ ...next, limit: 500 });
      setSegmentPreview({ total: data.total || 0, clients: data.clients || [] });
      setContactIds((data.clients || []).map((c: any) => c.id));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось загрузить сегмент"));
    } finally {
      setBusy(false);
    }
  }

  async function onImportFile(file: File) {
    setBusy(true);
    try {
      const contentBase64 = await readFileBase64(file);
      setImportFileMeta({ fileName: file.name, contentBase64 });
      const data: any = await api.parseContactImport({ fileName: file.name, contentBase64 });
      setImportPreview(data);
      setImportMapping(data.mapping || {});
      if (data.phoneListText) {
        setPhoneText(data.phoneListText);
        await parsePhones(data.phoneListText);
      }
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось разобрать файл"));
    } finally {
      setBusy(false);
    }
  }

  async function reapplyImportMapping(nextMapping: Record<string, string>) {
    if (!importFileMeta) return;
    setImportMapping(nextMapping);
    setBusy(true);
    try {
      const data: any = await api.parseContactImport({
        fileName: importFileMeta.fileName,
        contentBase64: importFileMeta.contentBase64,
        mapping: nextMapping,
      });
      setImportPreview(data);
      if (data.phoneListText) {
        setPhoneText(data.phoneListText);
        await parsePhones(data.phoneListText);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось применить mapping"));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (initialPhoneText.trim()) void parsePhones(initialPhoneText);
    if (initialSegment) void runSegment(initialSegment, false);
  }, []);

  useEffect(() => {
    if (whoMode !== "contacts") return;
    setSearchLoading(true);
    const timer = setTimeout(() => {
      api
        .searchContacts(searchQ.trim())
        .then((data: any) => setSearchHits(data.clients || []))
        .catch(() => setSearchHits([]))
        .finally(() => setSearchLoading(false));
    }, searchQ.trim() ? 220 : 0);
    return () => clearTimeout(timer);
  }, [searchQ, whoMode]);

  useEffect(() => {
    if (!initialContactIds.length) return;
    let cancelled = false;
    void api
      .searchContacts("")
      .then((data: any) => {
        if (cancelled) return;
        const byId = new Map<string, PickerClient>((data.clients || []).map((item: PickerClient) => [item.id, item]));
        setSelectedContacts(
          initialContactIds.map((id) => byId.get(id) || { id, name: "Клиент CRM", phone: null }),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedContacts(initialContactIds.map((id) => ({ id, name: "Клиент CRM", phone: null })));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleContact(hit: PickerClient) {
    setPrepare(null);
    setSelectedContacts((previous) => {
      const exists = previous.some((item) => item.id === hit.id);
      const next = exists ? previous.filter((item) => item.id !== hit.id) : [...previous, hit];
      setContactIds(next.map((item) => item.id));
      return next;
    });
  }

  function resolveScheduleIso() {
    if (whenMode !== "schedule") return { iso: null as string | null, error: "" };
    const date = parseScheduleDate(scheduledAt, scheduleInputRef.current);
    if (!date || date.getTime() <= Date.now()) {
      document.getElementById("campaign-when")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return { iso: null, error: uiText("Укажите дату и время в будущем") };
    }
    const normalized = toDateTimeLocal(date);
    if (normalized !== scheduledAt) setScheduledAt(normalized);
    return { iso: date.toISOString(), error: "" };
  }

  async function createDraft() {
    const schedule = resolveScheduleIso();
    if (schedule.error) {
      setError(schedule.error);
      return;
    }
    setBusy(true);
    try {
      const body: any = {
        title: commandText || message.trim().slice(0, 120) || "Массовая отправка",
        source: commandText ? "ai_command" : whoMode === "import" ? "import" : whoMode === "segment" ? "segment" : "manual",
        messageDraft: messageMode === "file_only" ? "" : message,
        messageMode,
        personalizeEach: personalizeEach && messageMode !== "file_only",
        createMissingClients: createMissing,
        scheduledAt: schedule.iso,
        rawCommandText: commandText || (personalizeEach || messageMode === "ai" ? message.trim() : "") || undefined,
        contactIds: whoMode === "contacts" || whoMode === "segment" ? contactIds : undefined,
        phoneListText:
          whoMode === "phones" || whoMode === "import"
            ? validPhones.map((item) => item.phoneRaw || item.raw).join("\n")
            : undefined,
        segment: undefined,
      };
      const created: any = await api.createCampaign(body);
      setCampaignId(created.campaign.id);
      setCampaign(created.campaign);
      if (queuedUploads.length) {
        for (const file of queuedUploads) {
          await api.addCampaignAttachment(created.campaign.id, {
            fileName: file.fileName,
            mimeType: file.mimeType,
            contentBase64: file.contentBase64,
            documentType: file.documentType || "document",
          });
        }
        setQueuedUploads([]);
      }
      await refreshCampaign(created.campaign.id);
      if (personalizeEach && messageMode !== "file_only") {
        const personalized = await api.personalizeCampaignRecipients(created.campaign.id);
        setCampaign(personalized);
      }
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось создать рассылку"));
    } finally {
      setBusy(false);
    }
  }

  async function refreshCampaign(id = campaignId) {
    if (!id) return;
    const data = await api.campaign(id);
    setCampaign(data);
    setAttachments((data as any).attachments || []);
    if (typeof (data as any).personalizeEach === "boolean") setPersonalizeEach((data as any).personalizeEach);
    if ((data as any).scheduledAt) {
      setWhenMode("schedule");
      setScheduledAt(toDateTimeLocal(new Date((data as any).scheduledAt)));
    }
  }

  async function onPersonalizeOffers() {
    if (!campaignId) {
      setError(uiText("Сначала подготовьте черновик рассылки — затем составим тексты каждому"));
      return;
    }
    setBusy(true);
    try {
      await api.updateCampaign(campaignId, {
        messageDraft: messageMode === "file_only" ? "" : message,
        messageMode,
        personalizeEach: true,
      });
      const data = await api.personalizeCampaignRecipients(campaignId);
      setCampaign(data);
      setPersonalizeEach(true);
      setPrepare(null);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось составить предложения"));
    } finally {
      setBusy(false);
    }
  }

  function setRecipientDraft(id: string, messageDraft: string) {
    setCampaign((prev: any) => {
      if (!prev?.recipients) return prev;
      return {
        ...prev,
        recipients: prev.recipients.map((row: any) => (row.id === id ? { ...row, messageDraft } : row)),
      };
    });
    setPrepare(null);
  }

  async function onAttachFiles(files: FileList | File[]) {
    setBusy(true);
    try {
      if (!campaignId) {
        const next: typeof queuedUploads = [];
        for (const file of Array.from(files)) {
          const contentBase64 = await readFileBase64(file);
          const mimeType = guessMimeType(file);
          next.push({
            fileName: file.name,
            mimeType,
            contentBase64,
            documentType: mimeType.startsWith("image/")
              ? "image"
              : file.name.toLowerCase().includes("кп") || file.name.toLowerCase().includes("offer")
                ? "proposal"
                : "document",
            sizeBytes: file.size,
          });
        }
        setQueuedUploads((prev) => [...prev, ...next].slice(0, 20));
        setError("");
        return;
      }
      for (const file of Array.from(files)) {
        const contentBase64 = await readFileBase64(file);
        const mimeType = guessMimeType(file);
        await api.addCampaignAttachment(campaignId, {
          fileName: file.name,
          mimeType,
          contentBase64,
          documentType: mimeType.startsWith("image/")
            ? "image"
            : file.name.toLowerCase().includes("кп") || file.name.toLowerCase().includes("offer")
              ? "proposal"
              : "document",
        });
      }
      await refreshCampaign();
      setPrepare(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось прикрепить файл"));
    } finally {
      setBusy(false);
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer.files?.length) void onAttachFiles(event.dataTransfer.files);
  }

  async function onAiDraft() {
    setBusy(true);
    try {
      const draft: any = await api.draftCampaignMessage(
        commandText.trim() || message.trim() || "массовая отправка",
        attachments.length > 0,
      );
      setMessage(draft.messageDraft);
      setMessageMode("ai");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось сформировать текст"));
    } finally {
      setBusy(false);
    }
  }

  async function onPrepare() {
    if (!campaignId) return;
    const schedule = resolveScheduleIso();
    if (schedule.error) {
      setError(schedule.error);
      return;
    }
    setBusy(true);
    try {
      await api.updateCampaign(campaignId, {
        messageDraft: messageMode === "file_only" ? "" : message,
        messageMode,
        personalizeEach: personalizeEach && messageMode !== "file_only",
        createMissingClients: createMissing,
        scheduledAt: schedule.iso,
        recipientDrafts:
          personalizeEach && messageMode !== "file_only"
            ? ((campaign?.recipients || []) as Array<{ id: string; status: string; messageDraft?: string | null }>)
                .filter((row) => row.status === "pending")
                .map((row) => ({ id: row.id, messageDraft: row.messageDraft || null }))
            : undefined,
      });
      const preview = await api.prepareCampaign(campaignId);
      setPrepare(preview);
      await refreshCampaign();
      setNotice({
        kind: "prepare",
        title: "Проверьте рассылку",
        text: schedule.iso
          ? uiText("Ниже подтвердите — тогда появится задача в «Запланировано». Пока ничего не уходит.")
          : uiText("Ниже подтвердите отправку. Пока сообщения не ушли."),
      });
      setError("");
      requestAnimationFrame(() => confirmRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось подготовить"));
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmAndSend() {
    if (!campaignId) return;
    const schedule = resolveScheduleIso();
    if (schedule.error) {
      setError(schedule.error);
      return;
    }
    setBusy(true);
    try {
      await api.updateCampaign(campaignId, {
        scheduledAt: schedule.iso,
      });
      const confirmed: any = await api.confirmCampaign(campaignId, {
        scheduledAt: schedule.iso,
      });
      const due = confirmed.campaign?.scheduledAt;
      const later = confirmed.campaign?.status === "scheduled" || (due && new Date(due).getTime() > Date.now());
      const recipients = Number(confirmed.preview?.recipients || confirmed.campaign?.statsJson?.total || 0);
      if (later) {
        setCampaign(await api.campaign(campaignId));
        setPrepare(null);
        setError("");
        setNotice({
          kind: "scheduled",
          title: "Задача создана в «Запланировано»",
          text: due
            ? uiText("Отправка {p0} запланирована на {p1}. Сообщения уйдут в это время, не сразу.", {p0: recipients || uiText("получателям"), p1: new Date(due).toLocaleString(uiFormatLocale())})
            : uiText("Рассылка стоит в очереди. Откройте фильтр «Запланировано»."),
        });
        onScheduled?.({
          dueAt: String(due || ""),
          recipients,
          title: String(confirmed.campaign?.title || "Массовая отправка"),
        });
        requestAnimationFrame(() => confirmRef.current?.scrollIntoView({ behavior: "smooth", block: "center" }));
        return;
      }
      const started: any = await api.startCampaign(campaignId);
      setCampaign(started);
      setPrepare(null);
      setError("");
      setNotice({
        kind: "sent",
        title: "Рассылка запущена",
        text: uiText("Сообщения поставлены в очередь на отправку."),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось запустить"));
    } finally {
      setBusy(false);
    }
  }

  const canCreateDraft =
    (whoMode === "phones" || whoMode === "import" ? validPhones.length > 0 : false) ||
    ((whoMode === "contacts" || whoMode === "segment") && contactIds.length > 0);

  const summary = phonePreview?.summary;

  return (
    <div className="panel task-form command-compose">
      <div className="command-compose-head">
        <div>
          <b>{uiText("Массовая отправка")}</b>
          <p className="muted">{uiText("Подготовка → проверка → подтверждение → очередь. Без мгновенной отправки.")}</p>
        </div>
        {onClose ? (
          <button type="button" className="btn secondary" onClick={onClose}>
            {uiText("Скрыть")}</button>
        ) : null}
      </div>

      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      {notice ? (
        <div className={notice.kind === "prepare" ? "banner warn" : "banner"} id="campaign-result" ref={notice.kind === "scheduled" ? confirmRef : undefined}>
          <b>{notice.title}</b>
          <InlineFeedback kind="info" message={`${notice.title}. ${notice.text}`}>{notice.text}</InlineFeedback>
        </div>
      ) : null}

      <div className="command-step">
        <div className="command-step-label">{uiText("Получатели")}</div>
        <div className="chip-row">
          {(
            [
              ["phones", uiText("Список номеров")],
              ["segment", uiText("Группа из CRM")],
              ["contacts", uiText("Клиенты CRM")],
              ["import", uiText("Импорт контактов")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={whoMode === value ? "chip active" : "chip"}
              onClick={() => {
                setWhoMode(value);
                setPrepare(null);
                if (value === "contacts") {
                  setContactIds(selectedContacts.map((item) => item.id));
                  setSearchLoading(true);
                }
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {whoMode === "phones" || whoMode === "import" ? (
          <>
            {whoMode === "import" ? (
              <div className="field-block">
                <label className="btn secondary">
                  {uiText("Загрузить CSV / XLSX")}<input
                    type="file"
                    hidden
                    accept=".csv,.xlsx,.xls,text/csv"
                    onChange={(event) => event.target.files?.[0] && onImportFile(event.target.files[0])}
                  />
                </label>
                {importPreview ? (
                  <div className="panel soft" style={{ marginTop: 8 }}>
                    <b>{uiText("Сопоставление колонок")}</b>
                    <p className="muted">
                      {uiText("Строк:")}{" "}{importPreview.summary?.totalRows} {" "}{uiText("· с телефоном:")}{" "}{importPreview.summary?.withPhone}
                    </p>
                    {(importPreview.headers || []).map((header: string) => (
                      <label key={header}>
                        {header}
                        <select
                          value={importMapping[header] || "skip"}
                          onChange={(event) =>
                            void reapplyImportMapping({ ...importMapping, [header]: event.target.value })
                          }
                        >
                          {localizeUiOptions(MAP_FIELDS, uiText).map(([id, label]) => (
                            <option key={id} value={id}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                    <p className="muted">{uiText("До подтверждения ничего не импортируем и не отправляем.")}</p>
                  </div>
                ) : (
                  <p className="muted">{uiText("Нужны колонки: телефон (обязательно), имя, компания, email, услуга, комментарий.")}</p>
                )}
              </div>
            ) : (
              <label>
                {uiText("Вставьте номера")}<textarea
                  rows={6}
                  value={phoneText}
                  onChange={(event) => {
                    setPhoneText(event.target.value);
                    setPhonePreview(null);
                  }}
                  placeholder={"+7 701 111 22 33\n+7 777 444 55 66\n87071234567\n+7 705 000 00 01"}
                />
              </label>
            )}
            {whoMode === "phones" ? (
              <div className="actions">
                <button type="button" className="btn" disabled={busy || !phoneText.trim()} onClick={() => parsePhones()}>
                  {uiText("Распознать список")}</button>
              </div>
            ) : null}
            {summary ? (
              <div className="panel soft">
                <b>{uiText("Распознано")}{" "}{summary.total} {" "}{uiText("контактов")}</b>
                <div className="command-summary" style={{ marginTop: 8 }}>
                  <div>
                    <span className="muted">{uiText("Корректные")}</span>
                    <b>{summary.valid}</b>
                  </div>
                  <div>
                    <span className="muted">{uiText("Найдены в CRM")}</span>
                    <b>{summary.existing}</b>
                  </div>
                  <div>
                    <span className="muted">{uiText("Новые номера")}</span>
                    <b>{summary.neu}</b>
                  </div>
                  <div>
                    <span className="muted">{uiText("Некорректные")}</span>
                    <b>{summary.invalid}</b>
                  </div>
                  <div>
                    <span className="muted">{uiText("Дубликаты")}</span>
                    <b>{summary.duplicates}</b>
                  </div>
                </div>
                <button type="button" className="linkish" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? uiText("Скрыть список") : uiText("Посмотреть все")}
                </button>
                {showAll ? (
                  <div className="picker-list" style={{ marginTop: 8 }}>
                    {(phonePreview?.items || []).map((item) => {
                      const excluded = excludedRaws.includes(item.raw);
                      const mark =
                        item.status === "ok_existing" || item.status === "ok_new" ? "✓" : item.status === "invalid" ? "!" : "—";
                      return (
                        <div key={`${item.raw}-${item.status}`} className={`picker-item ${excluded ? "muted" : ""}`}>
                          <div>
                            <b>
                              {mark} {item.displayName || item.phoneRaw || item.raw}
                            </b>
                            <div className="muted">
                              {item.displayName && item.phoneRaw ? item.phoneRaw : null}
                              {item.status === "ok_existing"
                                ? uiText(" Найден в CRM{p0}", {p0: item.interest ? ` · ${item.interest}` : ""})
                                : item.status === "ok_new"
                                  ? uiText(" Новый контакт")
                                  : ` ${item.reason || item.status}`}
                            </div>
                          </div>
                          {(item.status === "ok_existing" || item.status === "ok_new") && (
                            <button
                              type="button"
                              className="btn secondary"
                              onClick={() =>
                                setExcludedRaws((prev) => (excluded ? prev.filter((x) => x !== item.raw) : [...prev, item.raw]))
                              }
                            >
                              {excluded ? uiText("Вернуть") : uiText("Снять")}
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {whoMode === "segment" ? (
          <div className="field-block">
            <div className="chip-row">
              {localizeUiOptions(QUICK_SEGMENTS, uiText).map((item) => (
                <button key={item.id} type="button" className="chip" onClick={() => void runSegment(item.body as SegmentBody)}>
                  {item.label}
                </button>
              ))}
            </div>
            <div className="actions">
              <button type="button" className="btn secondary" disabled={busy} onClick={() => void runSegment(segment || {}, false)}>
                {uiText("Обновить выборку")}</button>
            </div>
            {segmentPreview ? (
              <p>
                {uiText("В сегменте:")}{" "}<b>{segmentPreview.total}</b> {" "}{uiText("· к отправке:")}{" "}<b>{contactIds.length}</b>
              </p>
            ) : (
              <p className="muted">{uiText("Выберите сегмент — например «Сайты · 30 дней · без продажи».")}</p>
            )}
          </div>
        ) : null}

        {whoMode === "contacts" ? (
          <div className="field-block">
            {selectedContacts.length ? (
              <div className="cmd-selected-list">
                <div className="muted" style={{ marginBottom: 6 }}>
                  {uiText("Выбрано клиентов из CRM:")}{" "}{selectedContacts.length}
                </div>
                {selectedContacts.map((client) => (
                  <div key={client.id} className="selected-client compact">
                    <div>
                      <b>{nameWithPhone(client.name, client.phone)}</b>
                      <div className="muted">{[client.companyName, client.interest].filter(Boolean).join(" · ")}</div>
                    </div>
                    <button type="button" className="btn secondary" onClick={() => toggleContact(client)}>
                      {uiText("Убрать")}</button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">{uiText("Выбрано клиентов из CRM: 0")}</p>
            )}
            <label>
              {uiText("Найти или выбрать клиента")}<input
                value={searchQ}
                onChange={(event) => setSearchQ(event.target.value)}
                placeholder={uiText("Имя, телефон, компания")}
                autoComplete="off"
              />
            </label>
            {searchHits.length > 0 ? (
              <>
                <div className="muted" style={{ marginTop: 8 }}>
                  {searchQ.trim() ? uiText("Найдено: {p0}", {p0: searchHits.length}) : uiText("Клиенты CRM — нажмите, чтобы выбрать")}
                </div>
                <div className="picker-list" role="listbox" aria-label={uiText("Клиенты CRM")}>
                  {searchHits.map((hit) => {
                    const already = selectedContacts.some((item) => item.id === hit.id);
                    return (
                      <button
                        key={hit.id}
                        type="button"
                        className="picker-item"
                        disabled={already}
                        onClick={() => {
                          if (already) return;
                          toggleContact(hit);
                          setSearchQ("");
                        }}
                      >
                        <b>{nameWithPhone(hit.name, hit.phone)}</b>
                        <div className="muted">
                          {[hit.companyName, hit.interest, uiMessage(hit.statusLabel)].filter(Boolean).join(" · ")}
                          {already ? uiText(" · уже выбран") : ""}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : searchQ.trim() ? (
              <p className="muted">{uiText("Никого не нашли. Попробуйте другой запрос или вкладку «Список номеров».")}</p>
            ) : (
              <p className="muted">{searchLoading ? uiText("Загрузка клиентов…") : uiText("В CRM пока нет клиентов для выбора.")}</p>
            )}
          </div>
        ) : null}

        {whoMode === "phones" || whoMode === "import" ? (
          <fieldset className="field-block">
            <legend className="muted">{uiText("Что делать с новыми контактами?")}</legend>
            <label className="check-row">
              <input type="radio" checked={createMissing} onChange={() => setCreateMissing(true)} />
              {uiText("Создать клиентов автоматически (минимальные записи)")}</label>
            <label className="check-row">
              <input type="radio" checked={!createMissing} onChange={() => setCreateMissing(false)} />
              {uiText("Отправить без создания клиента")}</label>
          </fieldset>
        ) : null}
      </div>

      <div className="command-step">
        <div className="command-step-label">{uiText("Сообщение")}</div>
        <div className="chip-row">
          {(
            [
              ["ai", uiText("Сформировать с AI")],
              ["manual", uiText("Написать вручную")],
              ["file_only", uiText("Без текста — только файл")],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={messageMode === value ? "chip active" : "chip"}
              onClick={() => {
                setMessageMode(value);
                if (value === "ai") setPersonalizeEach(true);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {messageMode !== "file_only" ? (
          <>
            <textarea
              rows={4}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={
                messageMode === "ai" || personalizeEach
                  ? uiText("Что сделать клиентам, например: уточнить удобное время для созвона")
                  : uiText("{{firstName}}, добрый день! ...")
              }
            />
            {messageMode === "ai" && !personalizeEach ? (
              <button type="button" className="btn secondary" disabled={busy} onClick={onAiDraft}>
                {uiText("Сгенерировать черновик")}</button>
            ) : null}
            <p className="muted">
              {messageMode === "ai" || personalizeEach
                ? uiText("Это задача для CRM, не текст в WhatsApp. В письмо пойдёт смысл команды, а факты — из заявки, без копирования приказа и без выдуманных цен.")
                : uiText("Переменные: {{firstName}}, {{companyName}}, {{service}}, {{managerName}}. Пустое имя не даст «, добрый день!».")}
            </p>
            <label className="check-row">
              <input
                type="checkbox"
                checked={personalizeEach}
                onChange={(event) => {
                  setPersonalizeEach(event.target.checked);
                  setPrepare(null);
                }}
              />
              {uiText("Составить разное предложение каждому получателю")}</label>
            {personalizeEach ? (
              <div className="field-block">
                <p className="muted">
                  {uiText("CRM возьмёт суть вашей команды и подставит факты заявки: имя, что просил клиент, компания. Цены, скидки и сроки не выдумываем.")}</p>
                <button type="button" className="btn secondary" disabled={busy || !campaignId} onClick={() => void onPersonalizeOffers()}>
                  {campaign?.recipients?.some((row: any) => row.messageDraft) ? uiText("Пересобрать предложения") : uiText("Составить предложения из задачи")}
                </button>
                {!campaignId ? <p className="muted">{uiText("Сначала подготовьте черновик — кнопка станет активной.")}</p> : null}
                {(campaign?.recipients || []).filter((row: any) => row.status === "pending").some((row: any) => row.messageDraft) ? (
                  <div className="campaign-offer-list">
                    {(campaign.recipients as any[])
                      .filter((row) => row.status === "pending")
                      .map((row) => (
                        <label key={row.id} className="campaign-offer-item">
                          <b>{row.displayName || row.phoneRaw || uiText("Контакт")}</b>
                          <textarea
                            rows={3}
                            value={row.messageDraft || ""}
                            onChange={(event) => setRecipientDraft(row.id, event.target.value)}
                          />
                        </label>
                      ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </>
        ) : (
          <p className="muted">{uiText("Отправим только вложения — убедитесь, что канал это позволяет.")}</p>
        )}
      </div>

      <div className="command-step" id="campaign-when">
        <div className="command-step-label">{uiText("Когда")}</div>
        <div className="chip-row">
          <button
            type="button"
            className={whenMode === "now" ? "chip active" : "chip"}
            onClick={() => {
              setWhenMode("now");
              setPrepare(null);
            }}
          >
            {uiText("Сейчас")}</button>
          <button
            type="button"
            className={whenMode === "schedule" ? "chip active" : "chip"}
            onClick={() => {
              setWhenMode("schedule");
              setPrepare(null);
              if (!scheduledAt) setScheduledAt(toDateTimeLocal(new Date(Date.now() + 60 * 60 * 1000)));
            }}
          >
            {uiText("Запланировать")}</button>
        </div>
        {whenMode === "schedule" ? (
          <label>
            {uiText("Дата и время")}<input
              ref={scheduleInputRef}
              type="datetime-local"
              step="60"
              min={scheduleMin}
              value={scheduledAt}
              onChange={(event) => {
                setScheduledAt(event.target.value);
                setPrepare(null);
              }}
            />
          </label>
        ) : null}
      </div>

      <div className="command-step" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        <div className="command-step-label">
          {uiText("Вложения")}{attachments.length || queuedUploads.length
            ? ` · ${attachments.length + queuedUploads.length}`
            : ""}
        </div>
        <div className="actions">
          <label className="btn secondary">
            {uiText("+ Файл")}<input
              type="file"
              hidden
              multiple
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.webp,.txt,.zip,application/pdf,image/*"
              onChange={(event) => event.target.files && onAttachFiles(event.target.files)}
            />
          </label>
          <label className="btn secondary">
            {uiText("+ Документ")}<input
              type="file"
              hidden
              multiple
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
              onChange={(event) => event.target.files && onAttachFiles(event.target.files)}
            />
          </label>
          <label className="btn secondary">
            {uiText("+ Фото")}<input
              type="file"
              hidden
              multiple
              accept=".jpg,.jpeg,.png,.webp,image/*"
              onChange={(event) => event.target.files && onAttachFiles(event.target.files)}
            />
          </label>
          {!campaignId ? (
            <button type="button" className="btn" disabled={busy || !canCreateDraft} onClick={createDraft}>
              {uiText("Создать черновик рассылки")}</button>
          ) : (
            <span className="muted">{uiText("Черновик ·")}{" "}{campaignId.slice(0, 8)}</span>
          )}
        </div>
        <p className="muted">
          {uiText("Перетащите файлы сюда. PDF, DOC/X, XLS/X, PPT/X, JPG/PNG/WEBP.")}{!campaignId ? uiText(" Можно прикрепить до черновика — загрузим при создании.") : ""}
        </p>
        {queuedUploads.length ? (
          <div className="picker-list">
            {queuedUploads.map((file, index) => (
              <div key={`${file.fileName}-${index}`} className="picker-item">
                <div>
                  <b>{file.fileName}</b>
                  <div className="muted">
                    {uiText("в очереди ·")}{" "}{file.documentType}
                    {file.sizeBytes ? ` · ${formatBytes(file.sizeBytes)}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => setQueuedUploads((prev) => prev.filter((_, i) => i !== index))}
                >
                  {uiText("Удалить")}</button>
              </div>
            ))}
          </div>
        ) : null}
        {attachments.length ? (
          <div className="picker-list">
            {attachments.map((file) => (
              <div key={file.id} className="picker-item">
                <div>
                  <b>{file.fileName}</b>
                  <div className="muted">
                    {file.mimeType} · {formatBytes(file.sizeBytes)} · {file.documentType}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={async () => {
                    if (!campaignId) return;
                    await api.removeCampaignAttachment(campaignId, file.id);
                    await refreshCampaign();
                    setPrepare(null);
                  }}
                >
                  {uiText("Удалить")}</button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="actions">
        {!campaignId ? (
          <button type="button" className="btn" disabled={busy || !canCreateDraft} onClick={createDraft}>
            {uiText("Подготовить черновик")}</button>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={onPrepare}>
            {uiText("Проверить и подготовить")}</button>
        )}
      </div>

      {prepare ? (
        <div className="panel soft confirm-panel" id="campaign-confirm" ref={confirmRef}>
          <h3>{prepare.title || uiText("Проверьте рассылку")}</h3>
          <div className="kv">
            <div>
              <span>{uiText("Действие")}</span>
              <b>{prepare.action}</b>
            </div>
            <div>
              <span>{uiText("Получатели")}</span>
              <b>{prepare.recipients}</b>
            </div>
            <div>
              <span>{uiText("В CRM / новые")}</span>
              <b>
                {prepare.foundInCrm} / {prepare.newContacts}
              </b>
            </div>
            <div>
              <span>{uiText("Исключено")}</span>
              <b>{prepare.excluded}</b>
            </div>
            <div>
              <span>{uiText("Канал")}</span>
              <b>{prepare.channel}</b>
            </div>
            <div>
              <span>{uiText("Когда")}</span>
              <b>{prepare.when === "Сейчас" ? uiText("Сейчас") : new Date(prepare.when).toLocaleString(uiFormatLocale())}</b>
            </div>
          </div>
          {prepare.message ? <div className="message-preview">{prepare.message}</div> : null}
          {prepare.personalizeEach ? (
            <p className="muted">{uiText("Каждому получателю уйдёт свой текст — проверьте список ниже.")}</p>
          ) : null}
          {(prepare.personalizationPreviews || []).length ? (
            <div className="field-block">
              <div className="muted">{prepare.personalizeEach ? uiText("Тексты получателям") : uiText("Примеры персонализации")}</div>
              {(prepare.personalizationPreviews as any[]).map((item, index) => (
                <div key={`${item.label}-${index}`} className="panel soft">
                  <b>{item.label}</b>
                  <p>{item.text}</p>
                </div>
              ))}
            </div>
          ) : null}
          <details>
            <summary>{uiText("Посмотреть")}{" "}{prepare.recipients} {" "}{uiText("получателей")}</summary>
            <div className="picker-list">
              {(prepare.recipientsPreview || []).map((item: any) => (
                <div key={item.id} className="picker-item">
                  <div>
                    <b>{item.name || item.phone || uiText("Контакт")}</b>
                    <div className="muted">{item.phone}</div>
                    {item.message ? <p className="campaign-offer-preview">{item.message}</p> : null}
                  </div>
                </div>
              ))}
            </div>
          </details>
          {prepare.excluded > 0 ? (
            <details>
              <summary>{uiText("Не будут отправлены ·")}{" "}{prepare.excluded}</summary>
              <div className="picker-list">
                {(prepare.excludedPreview || []).map((item: any) => (
                  <div key={item.id} className="picker-item">
                    <b>{item.name || item.phone}</b>
                    <div className="muted">{item.reason}</div>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          <div className="actions">
            <button type="button" className="btn secondary" onClick={() => setPrepare(null)}>
              {prepare.buttons?.back || uiText("Вернуться и изменить")}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={onConfirmAndSend}>
              {prepare.buttons?.confirm || uiText("Подтвердить и отправить {p0} контактам", {p0: prepare.recipients})}
            </button>
          </div>
        </div>
      ) : null}

      {campaign && ["running", "completed", "partially_completed", "failed", "paused", "scheduled"].includes(campaign.status) ? (
        <div className="panel soft">
          <b>
            {campaign.status === "scheduled"
              ? campaign.scheduledAt
                ? uiText("Запланирована на {p0}", {p0: new Date(campaign.scheduledAt).toLocaleString(uiFormatLocale())})
                : uiText("Запланирована")
              : uiText("Статус: {p0}", {p0: campaign.status})}
          </b>
          <p>
            {campaign.status === "scheduled"
              ? uiText("Задача должна быть в фильтре «Запланировано». Сообщения уйдут в это время, не сразу.")
              : null}
            {uiText("Всего")}{" "}{(campaign.summary || campaign.statsJson)?.total ?? "—"} {" "}{uiText("· отправлено")}{" "}
            {(campaign.summary || campaign.statsJson)?.sent ?? 0} {" "}{uiText("· ошибки")}{" "}{(campaign.summary || campaign.statsJson)?.failed ?? 0}
          </p>
          <div className="actions">
            {campaign.status === "running" ? (
              <>
                <button type="button" className="btn secondary" onClick={() => campaignId && api.pauseCampaign(campaignId).then(() => refreshCampaign())}>
                  {uiText("Приостановить")}</button>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => campaignId && api.cancelCampaignRemainder(campaignId).then(() => refreshCampaign())}
                >
                  {uiText("Отменить остаток")}</button>
              </>
            ) : null}
            {(campaign.summary || campaign.statsJson)?.failed > 0 ? (
              <button type="button" className="btn" onClick={() => campaignId && api.retryFailedCampaign(campaignId).then(() => refreshCampaign())}>
                {uiText("Повторить для неуспешных")}</button>
            ) : null}
            <button type="button" className="btn secondary" onClick={() => refreshCampaign()}>
              {uiText("Обновить")}</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
