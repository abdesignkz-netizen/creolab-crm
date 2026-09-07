import { useEffect, useMemo, useState, type DragEvent } from "react";
import { api } from "../lib/api";

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
}) {
  const [whoMode, setWhoMode] = useState<"contacts" | "phones" | "segment" | "import">(
    initialWhoMode || (initialContactIds.length ? "contacts" : initialSegment ? "segment" : "phones"),
  );
  const [phoneText, setPhoneText] = useState(initialPhoneText);
  const [phonePreview, setPhonePreview] = useState<{ items: PhoneItem[]; summary: any } | null>(null);
  const [excludedRaws, setExcludedRaws] = useState<string[]>([]);
  const [message, setMessage] = useState(initialMessage);
  const [messageMode, setMessageMode] = useState<"manual" | "ai" | "file_only">("manual");
  const [createMissing, setCreateMissing] = useState(true);
  const [whenMode, setWhenMode] = useState<"now" | "schedule">("now");
  const [scheduledAt, setScheduledAt] = useState("");
  const [campaignId, setCampaignId] = useState<string | null>(null);
  const [campaign, setCampaign] = useState<any>(null);
  const [prepare, setPrepare] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [attachments, setAttachments] = useState<any[]>([]);
  const [queuedUploads, setQueuedUploads] = useState(initialPendingAttachments);
  const [contactIds, setContactIds] = useState(initialContactIds);
  const [segment, setSegment] = useState<SegmentBody | null>(initialSegment || null);
  const [segmentPreview, setSegmentPreview] = useState<{ total: number; clients: any[] } | null>(null);
  const [importPreview, setImportPreview] = useState<any>(null);
  const [importMapping, setImportMapping] = useState<Record<string, string>>({});
  const [importFileMeta, setImportFileMeta] = useState<{ fileName: string; contentBase64: string } | null>(null);

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
      setError(err instanceof Error ? err.message : "Не удалось разобрать номера");
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
      setError(err instanceof Error ? err.message : "Не удалось загрузить сегмент");
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
      setError(err instanceof Error ? err.message : "Не удалось разобрать файл");
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
      setError(err instanceof Error ? err.message : "Не удалось применить mapping");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (initialPhoneText.trim()) void parsePhones(initialPhoneText);
    if (initialSegment) void runSegment(initialSegment, false);
  }, []);

  async function createDraft() {
    setBusy(true);
    try {
      const body: any = {
        title: commandText || "Массовая отправка",
        source: commandText ? "ai_command" : whoMode === "import" ? "import" : whoMode === "segment" ? "segment" : "manual",
        messageDraft: messageMode === "file_only" ? "" : message,
        messageMode,
        createMissingClients: createMissing,
        scheduledAt: whenMode === "schedule" && scheduledAt ? new Date(scheduledAt).toISOString() : null,
        rawCommandText: commandText || undefined,
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
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать рассылку");
    } finally {
      setBusy(false);
    }
  }

  async function refreshCampaign(id = campaignId) {
    if (!id) return;
    const data = await api.campaign(id);
    setCampaign(data);
    setAttachments((data as any).attachments || []);
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
      setError(err instanceof Error ? err.message : "Не удалось прикрепить файл");
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
      const draft: any = await api.draftCampaignMessage(commandText || "массовая отправка", attachments.length > 0);
      setMessage(draft.messageDraft);
      setMessageMode("ai");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сформировать текст");
    } finally {
      setBusy(false);
    }
  }

  async function onPrepare() {
    if (!campaignId) return;
    setBusy(true);
    try {
      await api.updateCampaign(campaignId, {
        messageDraft: messageMode === "file_only" ? "" : message,
        messageMode,
        createMissingClients: createMissing,
        scheduledAt: whenMode === "schedule" && scheduledAt ? new Date(scheduledAt).toISOString() : null,
      });
      const preview = await api.prepareCampaign(campaignId);
      setPrepare(preview);
      await refreshCampaign();
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось подготовить");
    } finally {
      setBusy(false);
    }
  }

  async function onConfirmAndSend() {
    if (!campaignId) return;
    setBusy(true);
    try {
      const confirmed: any = await api.confirmCampaign(campaignId);
      if (confirmed.campaign?.status === "scheduled") {
        setCampaign(await api.campaign(campaignId));
        setPrepare(null);
        setError("");
        return;
      }
      const started: any = await api.startCampaign(campaignId);
      setCampaign(started);
      setPrepare(null);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось запустить");
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
          <b>Массовая отправка</b>
          <p className="muted">Подготовка → проверка → подтверждение → очередь. Без мгновенной отправки.</p>
        </div>
        {onClose ? (
          <button type="button" className="btn secondary" onClick={onClose}>
            Скрыть
          </button>
        ) : null}
      </div>

      {error ? <p className="error">{error}</p> : null}
      {(campaign as any)?.storageWarning ? (
        <p className="error">{(campaign as any).storageWarning}</p>
      ) : null}

      <div className="command-step">
        <div className="command-step-label">Получатели</div>
        <div className="chip-row">
          {(
            [
              ["phones", "Список номеров"],
              ["segment", "Группа из CRM"],
              ["contacts", "Клиенты CRM"],
              ["import", "Импорт контактов"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={whoMode === value ? "chip active" : "chip"}
              onClick={() => {
                setWhoMode(value);
                setPrepare(null);
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
                  Загрузить CSV / XLSX
                  <input
                    type="file"
                    hidden
                    accept=".csv,.xlsx,.xls,text/csv"
                    onChange={(event) => event.target.files?.[0] && onImportFile(event.target.files[0])}
                  />
                </label>
                {importPreview ? (
                  <div className="panel soft" style={{ marginTop: 8 }}>
                    <b>Сопоставление колонок</b>
                    <p className="muted">
                      Строк: {importPreview.summary?.totalRows} · с телефоном: {importPreview.summary?.withPhone}
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
                          {MAP_FIELDS.map(([id, label]) => (
                            <option key={id} value={id}>
                              {label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                    <p className="muted">До подтверждения ничего не импортируем и не отправляем.</p>
                  </div>
                ) : (
                  <p className="muted">Нужны колонки: телефон (обязательно), имя, компания, email, услуга, комментарий.</p>
                )}
              </div>
            ) : (
              <label>
                Вставьте номера
                <textarea
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
                  Распознать список
                </button>
              </div>
            ) : null}
            {summary ? (
              <div className="panel soft">
                <b>Распознано {summary.total} контактов</b>
                <div className="command-summary" style={{ marginTop: 8 }}>
                  <div>
                    <span className="muted">Корректные</span>
                    <b>{summary.valid}</b>
                  </div>
                  <div>
                    <span className="muted">Найдены в CRM</span>
                    <b>{summary.existing}</b>
                  </div>
                  <div>
                    <span className="muted">Новые номера</span>
                    <b>{summary.neu}</b>
                  </div>
                  <div>
                    <span className="muted">Некорректные</span>
                    <b>{summary.invalid}</b>
                  </div>
                  <div>
                    <span className="muted">Дубликаты</span>
                    <b>{summary.duplicates}</b>
                  </div>
                </div>
                <button type="button" className="linkish" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? "Скрыть список" : "Посмотреть все"}
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
                                ? ` Найден в CRM${item.interest ? ` · ${item.interest}` : ""}`
                                : item.status === "ok_new"
                                  ? " Новый контакт"
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
                              {excluded ? "Вернуть" : "Снять"}
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
              {QUICK_SEGMENTS.map((item) => (
                <button key={item.id} type="button" className="chip" onClick={() => void runSegment(item.body as SegmentBody)}>
                  {item.label}
                </button>
              ))}
            </div>
            <div className="actions">
              <button type="button" className="btn secondary" disabled={busy} onClick={() => void runSegment(segment || {}, false)}>
                Обновить выборку
              </button>
            </div>
            {segmentPreview ? (
              <p>
                В сегменте: <b>{segmentPreview.total}</b> · к отправке: <b>{contactIds.length}</b>
              </p>
            ) : (
              <p className="muted">Выберите сегмент — например «Сайты · 30 дней · без продажи».</p>
            )}
          </div>
        ) : null}

        {whoMode === "contacts" ? (
          <p className="muted">Выбрано клиентов из CRM: {contactIds.length}</p>
        ) : null}

        <fieldset className="field-block">
          <legend className="muted">Что делать с новыми контактами?</legend>
          <label className="check-row">
            <input type="radio" checked={createMissing} onChange={() => setCreateMissing(true)} />
            Создать клиентов автоматически (минимальные записи)
          </label>
          <label className="check-row">
            <input type="radio" checked={!createMissing} onChange={() => setCreateMissing(false)} />
            Отправить без создания клиента
          </label>
        </fieldset>
      </div>

      <div className="command-step">
        <div className="command-step-label">Сообщение</div>
        <div className="chip-row">
          {(
            [
              ["ai", "Сформировать с AI"],
              ["manual", "Написать вручную"],
              ["file_only", "Без текста — только файл"],
            ] as const
          ).map(([value, label]) => (
            <button key={value} type="button" className={messageMode === value ? "chip active" : "chip"} onClick={() => setMessageMode(value)}>
              {label}
            </button>
          ))}
        </div>
        {messageMode !== "file_only" ? (
          <>
            <textarea rows={4} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="{{firstName}}, добрый день! ..." />
            {messageMode === "ai" ? (
              <button type="button" className="btn secondary" disabled={busy} onClick={onAiDraft}>
                Сгенерировать черновик
              </button>
            ) : null}
            <p className="muted">
              Переменные: {"{{firstName}}"}, {"{{companyName}}"}, {"{{service}}"}, {"{{managerName}}"}. Пустое имя не даст «, добрый день!».
            </p>
          </>
        ) : (
          <p className="muted">Отправим только вложения — убедитесь, что канал это позволяет.</p>
        )}
      </div>

      <div className="command-step" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        <div className="command-step-label">
          Вложения
          {attachments.length || queuedUploads.length
            ? ` · ${attachments.length + queuedUploads.length}`
            : ""}
        </div>
        <div className="actions">
          <label className="btn secondary">
            + Файл
            <input
              type="file"
              hidden
              multiple
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.jpg,.jpeg,.png,.webp,.txt,.zip,application/pdf,image/*"
              onChange={(event) => event.target.files && onAttachFiles(event.target.files)}
            />
          </label>
          <label className="btn secondary">
            + Документ
            <input
              type="file"
              hidden
              multiple
              accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
              onChange={(event) => event.target.files && onAttachFiles(event.target.files)}
            />
          </label>
          <label className="btn secondary">
            + Фото
            <input
              type="file"
              hidden
              multiple
              accept=".jpg,.jpeg,.png,.webp,image/*"
              onChange={(event) => event.target.files && onAttachFiles(event.target.files)}
            />
          </label>
          {!campaignId ? (
            <button type="button" className="btn" disabled={busy || !canCreateDraft} onClick={createDraft}>
              Создать черновик рассылки
            </button>
          ) : (
            <span className="muted">Черновик · {campaignId.slice(0, 8)}</span>
          )}
        </div>
        <p className="muted">
          Перетащите файлы сюда. PDF, DOC/X, XLS/X, PPT/X, JPG/PNG/WEBP.
          {!campaignId ? " Можно прикрепить до черновика — загрузим при создании." : ""}
        </p>
        {queuedUploads.length ? (
          <div className="picker-list">
            {queuedUploads.map((file, index) => (
              <div key={`${file.fileName}-${index}`} className="picker-item">
                <div>
                  <b>{file.fileName}</b>
                  <div className="muted">
                    в очереди · {file.documentType}
                    {file.sizeBytes ? ` · ${formatBytes(file.sizeBytes)}` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => setQueuedUploads((prev) => prev.filter((_, i) => i !== index))}
                >
                  Удалить
                </button>
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
                  Удалить
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="command-step">
        <div className="command-step-label">Когда</div>
        <div className="chip-row">
          <button type="button" className={whenMode === "now" ? "chip active" : "chip"} onClick={() => setWhenMode("now")}>
            Сейчас
          </button>
          <button type="button" className={whenMode === "schedule" ? "chip active" : "chip"} onClick={() => setWhenMode("schedule")}>
            Запланировать
          </button>
        </div>
        {whenMode === "schedule" ? (
          <label>
            Дата и время
            <input type="datetime-local" value={scheduledAt} onChange={(event) => setScheduledAt(event.target.value)} />
          </label>
        ) : null}
      </div>

      <div className="actions">
        {!campaignId ? (
          <button type="button" className="btn" disabled={busy || !canCreateDraft} onClick={createDraft}>
            Подготовить черновик
          </button>
        ) : (
          <button type="button" className="btn" disabled={busy} onClick={onPrepare}>
            Проверить и подготовить
          </button>
        )}
      </div>

      {prepare ? (
        <div className="panel soft confirm-panel">
          <h3>{prepare.title || "Проверьте рассылку"}</h3>
          <div className="kv">
            <div>
              <span>Действие</span>
              <b>{prepare.action}</b>
            </div>
            <div>
              <span>Получатели</span>
              <b>{prepare.recipients}</b>
            </div>
            <div>
              <span>В CRM / новые</span>
              <b>
                {prepare.foundInCrm} / {prepare.newContacts}
              </b>
            </div>
            <div>
              <span>Исключено</span>
              <b>{prepare.excluded}</b>
            </div>
            <div>
              <span>Канал</span>
              <b>{prepare.channel}</b>
            </div>
            <div>
              <span>Когда</span>
              <b>{prepare.when === "Сейчас" ? "Сейчас" : new Date(prepare.when).toLocaleString("ru-RU")}</b>
            </div>
          </div>
          {prepare.message ? <div className="message-preview">{prepare.message}</div> : null}
          {(prepare.personalizationPreviews || []).length ? (
            <div className="field-block">
              <div className="muted">Примеры персонализации</div>
              {(prepare.personalizationPreviews as any[]).map((item) => (
                <div key={item.label} className="panel soft">
                  <b>{item.label}</b>
                  <p>{item.text}</p>
                </div>
              ))}
            </div>
          ) : null}
          <details>
            <summary>Посмотреть {prepare.recipients} получателей</summary>
            <div className="picker-list">
              {(prepare.recipientsPreview || []).map((item: any) => (
                <div key={item.id} className="picker-item">
                  <b>{item.name || item.phone || "Контакт"}</b>
                  <div className="muted">{item.phone}</div>
                </div>
              ))}
            </div>
          </details>
          {prepare.excluded > 0 ? (
            <details>
              <summary>Не будут отправлены · {prepare.excluded}</summary>
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
              {prepare.buttons?.back || "Вернуться и изменить"}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={onConfirmAndSend}>
              {prepare.buttons?.confirm || `Подтвердить и отправить ${prepare.recipients} контактам`}
            </button>
          </div>
        </div>
      ) : null}

      {campaign && ["running", "completed", "partially_completed", "failed", "paused", "scheduled"].includes(campaign.status) ? (
        <div className="panel soft">
          <b>Статус: {campaign.status}</b>
          <p>
            Всего {(campaign.summary || campaign.statsJson)?.total ?? "—"} · отправлено{" "}
            {(campaign.summary || campaign.statsJson)?.sent ?? 0} · ошибки {(campaign.summary || campaign.statsJson)?.failed ?? 0}
          </p>
          <div className="actions">
            {campaign.status === "running" ? (
              <>
                <button type="button" className="btn secondary" onClick={() => campaignId && api.pauseCampaign(campaignId).then(() => refreshCampaign())}>
                  Приостановить
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  onClick={() => campaignId && api.cancelCampaignRemainder(campaignId).then(() => refreshCampaign())}
                >
                  Отменить остаток
                </button>
              </>
            ) : null}
            {(campaign.summary || campaign.statsJson)?.failed > 0 ? (
              <button type="button" className="btn" onClick={() => campaignId && api.retryFailedCampaign(campaignId).then(() => refreshCampaign())}>
                Повторить для неуспешных
              </button>
            ) : null}
            <button type="button" className="btn secondary" onClick={() => refreshCampaign()}>
              Обновить
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
