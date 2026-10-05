import { uiTaskTitle, uiText, useUiText, localizeUiOptions, uiMessage } from "../lib/uiText";
import { notifySaved } from "../components/SaveNotice";
import { useUrlState, useRequestVersion } from "../lib/useUrlState";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PERIOD_OPTIONS, formatCustomPeriodLabel } from "../lib/period";
import { tip } from "../lib/tip";
import { formatWaitSince } from "../lib/duration";
import { api } from "../lib/api";
import { statusBadgeClass } from "../lib/statusBadge";
import { Pagination } from "../components/Pagination";
import { useCapabilities } from "../lib/session";

const FILTERS = [
  ["all", "Все"],
  ["new", "Новые"],
  ["in_progress", "В работе"],
  ["needs_reply", "Нужен ответ"],
  ["today", "Сегодня"],
  ["overdue", "Просрочено"],
  ["no_next", "Без следующего шага"],
] as const;

const IMPORT_FIELDS = [
  ["phone", "Телефон"],
  ["name", "Имя"],
  ["company", "Компания"],
  ["email", "Email"],
  ["service", "Интерес / услуга"],
  ["comment", "Комментарий"],
  ["skip", "Пропустить"],
] as const;

function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(uiText("Не удалось прочитать файл")));
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.readAsDataURL(file);
  });
}

function clientsNewLabel(n: number) {
  const n10 = n % 10;
  const n100 = n % 100;
  const word = n10 === 1 && n100 !== 11 ? uiText("новый клиент") : n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14) ? uiText("новых клиента") : uiText("новых клиентов");
  return `${n} ${word}`;
}

export function ClientsPage() {
  const uiText = useUiText();
  const requestVersion = useRequestVersion();
  const navigate = useNavigate();
  const caps = useCapabilities();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingCreate = useRef<Record<string, unknown> | null>(null);
  const [filter, setFilter] = useUrlState("filter", "all", localizeUiOptions(FILTERS, uiText).map(([value]) => value));
  const [q, setQ] = useUrlState<string>("q", "");
  const [draft, setDraft] = useState(q);
  const [showFilters, setShowFilters] = useState(false);
  const [status, setStatus] = useUrlState<string>("status", "");
  const [source, setSource] = useUrlState<string>("source", "");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [period] = useUrlState<string>("period", "all");
  const [dateFrom] = useUrlState<string>("from", "");
  const [dateTo] = useUrlState<string>("to", "");
  const [owner] = useUrlState<string>("owner", "");
  const [creating, setCreating] = useState(false);
  const [duplicates, setDuplicates] = useState<any[]>([]);
  const [importPreview, setImportPreview] = useState<any>(null);
  const [importMapping, setImportMapping] = useState<Record<string, string>>({});
  const [importFile, setImportFile] = useState<{ name: string; contentBase64: string } | null>(null);
  const [importResult, setImportResult] = useState<any>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [mergeKeep, setMergeKeep] = useState("");
  const [mergeSource, setMergeSource] = useState("");
  const [offset, setOffset] = useUrlState<string>("offset", "0");
  const [loading, setLoading] = useState(true);

  async function load(next: { filter?: string; q?: string; status?: string; source?: string } = {}) {
    const request = ++requestVersion.current;
    setLoading(true);
    try {
      const query: Record<string, string> = {
        filter: next.filter ?? filter,
        owner,
        period,
        dateFrom,
        dateTo,
        offset,
      };
      const queryText = next.q ?? q;
      if (queryText) query.q = queryText;
      const st = next.status ?? status;
      const src = next.source ?? source;
      if (st) query.status = st;
      if (src) query.source = src;
      const result = await api.contacts(query);
      if (request !== requestVersion.current) return;
      setData(result);
      setError("");
    } catch (err) {
      if (request !== requestVersion.current) return;
      setError(err instanceof Error ? err.message : uiText("Ошибка"));
    } finally {
      if (request === requestVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [filter, q, status, source, period, dateFrom, dateTo, owner, offset]);

  useEffect(() => setDraft(q), [q]);

  const newClients = Number(data?.attention?.new ?? data?.metrics?.new ?? 0);
  const waitingReply = Number(data?.attention?.needsReply ?? data?.metrics?.needsReply ?? 0);
  function openNewClients() {
    navigate("/contacts?filter=new");
  }

  async function submitCreate(force = false) {
    const payload = pendingCreate.current;
    if (!payload) return;
    try {
      const created = (await api.createContact({ ...payload, forceCreate: force || undefined })) as any;
      notifySaved(uiText("Клиент создан"));
      setDuplicates([]);
      pendingCreate.current = null;
      navigate(`/contacts/${created.client.id}`);
    } catch (err: any) {
      if (err?.status === 409) {
        const details = err.body?.details || err.body;
        setDuplicates(details?.duplicates || []);
        if (!details?.duplicates?.length) {
          try {
            const dup: any = await api.contactDuplicates({
              phone: String(payload.phone || ""),
              name: String(payload.name || ""),
            });
            setDuplicates(dup.duplicates || []);
          } catch {
            setError(err instanceof Error ? err.message : uiText("Не создано"));
          }
        }
      } else {
        setError(err instanceof Error ? err.message : uiText("Не создано"));
      }
    }
  }

  async function onImportFile(file: File) {
    setImportBusy(true);
    setImportResult(null);
    try {
      const contentBase64 = await readBase64(file);
      const preview: any = await api.parseContactImport({ fileName: file.name, contentBase64 });
      setImportFile({ name: file.name, contentBase64 });
      setImportPreview(preview);
      setImportMapping(preview.mapping || {});
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось разобрать файл"));
    } finally {
      setImportBusy(false);
    }
  }

  async function reapplyImportMapping(nextMapping: Record<string, string>) {
    if (!importFile) return;
    setImportMapping(nextMapping);
    try {
      const preview: any = await api.parseContactImport({
        fileName: importFile.name,
        contentBase64: importFile.contentBase64,
        mapping: nextMapping,
      });
      setImportPreview(preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось применить сопоставление"));
    }
  }

  async function runImport() {
    if (!importFile) return;
    setImportBusy(true);
    try {
      const result = await api.importContacts({
        fileName: importFile.name,
        contentBase64: importFile.contentBase64,
        mapping: importMapping,
      });
      setImportResult(result);
      notifySaved(uiText("Импортировано: {p0}", {p0: (result as any).created}));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Импорт не выполнен"));
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <section className="clients-page">
      <div className="page-head">
        <div>
          <h2>{uiText("Клиенты")}</h2>
          {filter === "new" ? (
          <p className="muted">{uiText("Новые клиенты, которых ещё не взяли в работу.")}</p>
          ) : (
            <p className="muted">{uiText("Кто пришёл, откуда и что делать дальше.")}</p>
          )}
        </div>
        <div className="actions">
          <button type="button" className="btn secondary" onClick={() => fileInputRef.current?.click()}>
            {uiText("Импорт")}</button>
          <button
            type="button"
            className="btn secondary"
            onClick={() => {
              void api.exportContacts().then((result: any) => {
                const blob = new Blob([result.csv || ""], { type: "text/csv;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = result.filename || "clients.csv";
                link.click();
                URL.revokeObjectURL(url);
              }).catch((err) => setError(err instanceof Error ? err.message : uiText("Не удалось выгрузить")));
            }}
          >
            {uiText("Экспорт")}</button>
          <button className="btn" onClick={() => setCreating((value) => !value)}>
            {uiText("+ Клиент")}</button>
          <input
            ref={fileInputRef}
            type="file"
            hidden
            accept=".csv,.xlsx,.xls,text/csv"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void onImportFile(file);
            }}
          />
        </div>
      </div>

      {period !== "all" || owner ? <div className="active-filter-note">
        <span>{period !== "all" ? uiText("Первое обращение: {p0}", {p0: period === "custom" ? formatCustomPeriodLabel(dateFrom, dateTo) : localizeUiOptions(PERIOD_OPTIONS, uiText).find(option => option.id === period)?.label || period}) : ""}{owner ? ` · ${owner === "me" ? uiText("Мои клиенты") : uiText("Без ответственного")}` : ""}</span>
        <button className="btn secondary" onClick={() => navigate("/contacts")}>{uiText("Снять отбор")}</button>
      </div> : null}
      {filter !== "new" && !q && newClients > 0 ? (
        <div className="active-filter-note">
          <span>{clientsNewLabel(newClients)} {" "}{uiText("ещё не взяты в работу.")}</span>
          <button type="button" className="btn secondary" onClick={openNewClients}>
            {uiText("Показать")}</button>
        </div>
      ) : null}
      {creating ? (
        <form
          className="panel"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            try {
              const createdPayload = {
                name: form.get("name"),
                phone: form.get("phone") || undefined,
                source: form.get("source") || "manual",
                comment: form.get("comment") || undefined,
                companyName: form.get("companyName") || undefined,
              };
              pendingCreate.current = createdPayload;
              await submitCreate(false);
            } catch (err) {
              setError(err instanceof Error ? err.message : uiText("Не создано"));
            }
          }}
        >
          <b>{uiText("Новый клиент")}</b>
          <label>
            {uiText("Имя")}<input name="name" required />
          </label>
          <label>
            {uiText("Телефон")}<input name="phone" placeholder="+7 ..." />
          </label>
          <label>
            {uiText("Компания")}<input name="companyName" />
          </label>
          <label>
            {uiText("Источник")}<select name="source" defaultValue="manual">
              <option value="manual">{uiText("Вручную")}</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="form">{uiText("Форма сайта")}</option>
              <option value="phone_call">{uiText("Звонок")}</option>
              <option value="api">API</option>
            </select>
          </label>
          <label>
            {uiText("Задача / комментарий")}<textarea name="comment" />
          </label>
          <button className="btn">{uiText("Создать")}</button>
          {duplicates.length ? (
            <div className="sit-section" style={{ marginTop: 12 }}>
              <b>{uiText("Возможный дубликат")}</b>
              {duplicates.map((item) => (
                <div key={item.id} className="row" style={{ marginTop: 8 }}>
                  <div>
                    <div>{item.name}</div>
                    <div className="muted">
                      {[item.phone, item.companyName, item.activeDealsCount != null ? uiText("{p0} сделок", {p0: item.activeDealsCount}) : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                  <div className="actions">
                    <Link className="btn secondary" to={`/contacts/${item.id}`}>
                      {uiText("Открыть существующего")}</Link>
                  </div>
                </div>
              ))}
              <button type="button" className="btn secondary" style={{ marginTop: 8 }} onClick={() => void submitCreate(true)}>
                {uiText("Создать отдельно")}</button>
            </div>
          ) : null}
        </form>
      ) : null}

      {importPreview ? (
        <div className="panel">
          <b>{uiText("Импорт клиентов")}</b>
          <p className="muted">
            {uiText("Строк:")}{" "}{importPreview.summary?.totalRows} {" "}{uiText("· с телефоном:")}{" "}{importPreview.summary?.withPhone}
          </p>
          {(importPreview.headers || []).map((header: string) => (
            <label key={header}>
              {header}
              <select
                value={importMapping[header] || "skip"}
                onChange={(event) => void reapplyImportMapping({ ...importMapping, [header]: event.target.value })}
              >
                {localizeUiOptions(IMPORT_FIELDS, uiText).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <div className="actions">
            <button type="button" className="btn" disabled={importBusy} onClick={() => void runImport()}>
              {uiText("Импортировать")}</button>
            <button
              type="button"
              className="btn secondary"
              onClick={() => {
                setImportPreview(null);
                setImportFile(null);
                setImportResult(null);
              }}
            >
              {uiText("Отмена")}</button>
          </div>
          {importResult ? (
            <div>
              <p className="muted">
                {uiText("Создано")}{" "}{importResult.created}{uiText(", пропущено")}{" "}{importResult.skipped}{uiText(", ошибок")}{" "}{importResult.errors}
              </p>
              {(importResult.skippedRows || []).slice(0, 8).map((row: any) => (
                <div key={`${row.row}-${row.existingId || ""}`} className="muted">
                  {uiText("Строка")}{" "}{row.row}: {row.reason}
                  {row.existingId ? (
                    <>
                      {" · "}
                      <Link to={`/contacts/${row.existingId}`}>{uiText("открыть")}</Link>
                      {caps.companyAdmin ? (
                        <>
                          {" · "}
                          <button
                            type="button"
                            className="btn secondary"
                            onClick={() => setMergeKeep(row.existingId)}
                          >
                            {uiText("оставить этого")}</button>
                        </>
                      ) : null}
                    </>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {caps.companyAdmin ? (
        <details className="panel">
          <summary>{uiText("Объединить дубликаты")}</summary>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (!mergeKeep || !mergeSource) return;
              try {
                await api.mergeContacts({ keepId: mergeKeep, mergeId: mergeSource });
                notifySaved(uiText("Клиенты объединены"));
                setMergeKeep("");
                setMergeSource("");
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : uiText("Не удалось объединить"));
              }
            }}
          >
            <p className="muted">{uiText("Оставляем первого клиента, второго архивируем и переносим заявки, сделки и диалоги.")}</p>
            <label>
              {uiText("Оставить")}<input value={mergeKeep} onChange={(e) => setMergeKeep(e.target.value)} placeholder={uiText("id клиента")} />
            </label>
            <label>
              {uiText("Объединить в него")}<input value={mergeSource} onChange={(e) => setMergeSource(e.target.value)} placeholder={uiText("id дубликата")} />
            </label>
            <button className="btn secondary" disabled={!mergeKeep || !mergeSource}>
              {uiText("Объединить")}</button>
          </form>
        </details>
      ) : null}

      <form
        className="search-bar"
        onSubmit={(event) => {
          event.preventDefault();
          setQ(draft.trim());
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={uiText("Имя, телефон, компания, задача, тег…")}
        />
        <button className="btn">{uiText("Найти")}</button>
        <button type="button" className="btn secondary" onClick={() => setShowFilters((value) => !value)}>
          {uiText("Фильтры")}</button>
      </form>

      {showFilters ? (
        <div className="filter-panel">
          <label>
            {uiText("Статус")}<select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">{uiText("Любой")}</option>
              <option value="new">{uiText("Новый")}</option>
              <option value="in_progress">{uiText("В работе")}</option>
              <option value="active">{uiText("Активный")}</option>
              <option value="paused">{uiText("На паузе")}</option>
              <option value="lost">{uiText("Потерян")}</option>
            </select>
          </label>
          <label>
            {uiText("Источник")}<select value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="">{uiText("Любой")}</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="form">{uiText("Форма")}</option>
              <option value="manual">{uiText("Вручную")}</option>
            </select>
          </label>
        </div>
      ) : null}

      <div className="actions chip-row">
        {localizeUiOptions(FILTERS, uiText).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={filter === value ? "btn" : "btn secondary"}
            {...(value === "today"
              ? tip(uiText("Клиенты, с которыми был контакт сегодня"))
              : value === "new"
                ? tip(uiText("Клиенты со статусом «Новый»"))
                : value === "needs_reply"
                  ? tip(uiText("Последнее сообщение было от клиента — ещё не ответили"))
                  : {})}
            onClick={() => (value === "new" ? openNewClients() : setFilter(value))}
          >
            {label}
            {value === "new" && newClients > 0 ? ` · ${newClients}` : ""}
            {value === "needs_reply" && waitingReply > 0 ? ` · ${waitingReply}` : ""}
          </button>
        ))}
      </div>

      {error ? <p className="error">{error}</p> : null}
      {!data ? <div className="state">{uiText("Загрузка…")}</div> : null}
      {data && data.items.length === 0 ? (
        <p className="empty">
          {filter === "new"
            ? uiText("Нет новых клиентов.")
            : filter === "needs_reply"
            ? uiText("Нет клиентов, которые ждут ответа.")
            : q || filter !== "all"
              ? uiText("По выбранным условиям клиенты не найдены.")
              : uiText("Здесь появятся ваши клиенты после подключения каналов.")}
        </p>
      ) : null}

      {data ? <Pagination total={data.total} offset={data.offset} limit={data.limit} loading={loading} onChange={next => setOffset(String(next))} /> : null}
      {data?.items.map((item: any) => (
        <Link className="client-row" key={item.id} to={`/contacts/${item.id}`}>
          <div className="client-row-main">
            <div className="client-row-title">
              <b>{item.name}</b>
              {item.companyName ? <span className="muted"> · {item.companyName}</span> : null}
            </div>
            <div className="muted">{item.phone || uiText("Нет телефона")}</div>
            <div className="client-meta">
              <span className={statusBadgeClass(uiMessage(item.lifecycleLabel))}>{uiMessage(item.lifecycleLabel)}</span>
              {uiMessage(item.inquiryStatusLabel) ? <span className="badge">{uiMessage(item.inquiryStatusLabel)}</span> : null}
              {item.needsReply ? (
                <span className="badge warn">
                  {uiText("Нужен ответ")}{item.waitMinutes != null ? ` · ${formatWaitSince(item.waitMinutes)}` : ""}
                </span>
              ) : null}
              {item.overdue ? <span className="badge danger">{uiText("Просрочено")}</span> : null}
              {item.activeDeal ? <span className="badge">{uiText("Сделка")}</span> : null}
            </div>
            <div className="muted">
              {item.interest || uiText("Интерес пока не определён")}
              {item.interestSource === "conversation" ? (
                <span className="badge" {...tip(uiText("Определено по сообщению клиента. Откройте карточку, чтобы проверить переписку."))}>{uiText("Из переписки")}</span>
              ) : null}
              {item.sourceLabel ? ` · ${uiMessage(item.sourceLabel)}` : ""}
              {item.acquisition ? ` · ${item.acquisition}` : ""}
            </div>
            <div className="muted">
              {uiText("Первое:")}{" "}{item.firstContactLabel || "—"} {" "}{uiText("· Последний:")}{" "}{item.lastContactLabel || "—"}
              {item.inquiryCount ? uiText(" · Заявок: {p0}", {p0: item.inquiryCount}) : ""}
              {item.openTaskCount ? uiText(" · Задач: {p0}", {p0: item.openTaskCount}) : ""}
            </div>
          </div>
          <div className="client-row-side">
            <div>
              <span className="muted">{uiText("Следующее действие")}</span>
              <div>
                {item.nextAction ? (
                  <>
                    {uiTaskTitle(item.nextAction)}
                    {item.nextAction.dueLabel ? ` · ${item.nextAction.dueLabel}` : ""}
                  </>
                ) : item.missingNextAction ? (
                  <span className="warn-text">{uiText("Нет следующего действия")}</span>
                ) : (
                  "—"
                )}
              </div>
            </div>
            <div className="muted">{uiText("Ответственный:")}{" "}{item.ownerName || uiText("не назначен")}</div>
          </div>
        </Link>
      ))}
      {data && (data.hasMore || data.offset > 0) ? <Pagination total={data.total} offset={data.offset} limit={data.limit} loading={loading} onChange={next => setOffset(String(next))} /> : null}
    </section>
  );
}
