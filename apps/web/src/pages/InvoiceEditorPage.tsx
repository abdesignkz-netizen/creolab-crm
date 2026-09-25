import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ESF_DEFAULT_MEASURE_UNIT_CODE,
  invoiceEditorSchema,
  invoicePayableTotals,
  resolveEsfMeasureUnitCode,
  type InvoiceEditorInput,
} from "@creolab/contracts";
import { documentErrorFields, documentFieldLabel } from "../lib/documentErrors";
import { api, downloadInvoicePdf } from "../lib/api";
import { EsfMeasureUnitSelect } from "../components/EsfMeasureUnitSelect";
import { PdfDocumentViewer } from "../components/PdfDocumentViewer";
import { notifySaved } from "../components/SaveNotice";

const money = (v: unknown) => Number(v || 0).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const empty: InvoiceEditorInput = {
  documentDate: new Date().toISOString().slice(0, 10),
  paymentPercent: 100,
  withoutContract: false,
  contractNumber: "",
  contractDate: "",
  items: [],
};
const partyFields = [
  ["legalName", "Название"],
  ["bin", "БИН / ИИН"],
  ["legalAddress", "Юридический адрес"],
  ["iban", "ИИК / IBAN"],
  ["bankName", "Банк"],
  ["bik", "БИК"],
  ["phone", "Телефон"],
  ["email", "Email"],
] as const;
const labels: Record<string, string> = { DRAFT: "Черновик", ISSUED: "Выставлен", PARTIALLY_PAID: "Частично оплачен", PAID: "Оплачен", OVERDUE: "Просрочен", CANCELLED: "Отменён" };

export function InvoiceEditorPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [deals, setDeals] = useState<any[]>([]);
  const [companies, setCompanies] = useState<any[]>([]);
  const [source, setSource] = useState<"deals" | "companies">("deals");
  const [filter, setFilter] = useState(params.get("filter") === "ready" ? "ready" : "all");
  const [q, setQ] = useState("");
  const [context, setContext] = useState<any>(null);
  const [doc, setDoc] = useState<any>(null);
  const [form, setForm] = useState<InvoiceEditorInput>(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [editingBuyer, setEditingBuyer] = useState(false);
  const [buyer, setBuyer] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState<{ id: string; stamped: boolean } | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewError, setPreviewError] = useState("");
  const flight = useRef(false);
  const version = useRef(0);
  const issueSummary = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (error || Object.keys(issues).length) issueSummary.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [error, issues]);
  useEffect(() => {
    if (!preview) {
      setPreviewUrl("");
      setPreviewError("");
      return;
    }
    let live = true;
    let objectUrl = "";
    setPreviewUrl("");
    setPreviewError("");
    void api
      .downloadInvoicePdf(preview.id, { stamped: preview.stamped })
      .then(({ blob }) => {
        if (!live) return;
        objectUrl = URL.createObjectURL(blob);
        setPreviewUrl(objectUrl);
      })
      .catch((err: unknown) => {
        if (live) setPreviewError(err instanceof Error ? err.message : "Не удалось открыть счёт");
      });
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [preview]);
  const immutable = Boolean(doc && !["DRAFT", "ISSUED"].includes(doc.status));
  const parsed = invoiceEditorSchema.safeParse(form);
  const totals = parsed.success ? invoicePayableTotals(form.items, form.paymentPercent) : null;

  async function loadDeal(dealId: string, existing?: any) {
    const current = ++version.current;
    setBusy(true);
    setError("");
    try {
      const ctx: any = await api.request(`/api/v1/deals/${dealId}/invoice-context`);
      if (current !== version.current) return;
      let record = existing || ctx.invoice;
      if (!record && ctx.existingInvoiceId) {
        const r: any = await api.request(`/api/v1/invoices/${ctx.existingInvoiceId}`);
        record = r.invoice;
      }
      if (current !== version.current) return;
      const toEditorItems = (rows: any[] = []) =>
        rows.map((r: any) => ({
          name: r.name || "",
          quantity: r.quantity,
          unit: resolveEsfMeasureUnitCode(r.unit),
          unitPrice: r.unitPrice,
          vatRate: r.vatRate ?? 0,
        }));
      setContext(ctx);
      setDoc(record || null);
      setForm(
        record
          ? {
              documentDate: String(record.date || record.documentDate || ctx.editor?.documentDate || empty.documentDate).slice(0, 10),
              paymentPercent: record.paymentPercent || ctx.editor?.paymentPercent || 100,
              withoutContract: Boolean(record.withoutContract ?? ctx.editor?.withoutContract),
              contractNumber: record.withoutContract ? "" : record.contractNumber || ctx.editor?.contractNumber || ctx.contract?.number || "",
              contractDate: record.withoutContract ? "" : String(record.contractDate || ctx.editor?.contractDate || ctx.contract?.date || "").slice(0, 10),
              items: toEditorItems(record.items || ctx.editor?.items || []),
            }
          : { ...empty, items: toEditorItems(ctx.items), contractNumber: ctx.contract?.number || "", contractDate: String(ctx.contract?.date || "").slice(0, 10) },
      );
      setDirty(false);
      setIssues({});
      setEditingBuyer(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      if (current === version.current) setBusy(false);
    }
  }

  useEffect(() => {
    let live = true;
    if (id) {
      void api
        .request<any>(`/api/v1/invoices/${id}`)
        .then((r) => {
          if (live) void loadDeal(r.invoice.dealId, r.invoice);
        })
        .catch((e) => setError(e.message));
    } else if (params.get("dealId")) void loadDeal(params.get("dealId")!);
    return () => {
      live = false;
      version.current++;
    };
  }, [id]);

  useEffect(() => {
    if (context) return;
    let active = true;
    const path =
      source === "companies"
        ? `/api/v1/documents/invoices/eligible-companies?q=${encodeURIComponent(q)}`
        : `/api/v1/documents/invoices/eligible-deals?filter=${filter}&q=${encodeURIComponent(q)}`;
    void api
      .request<any>(path)
      .then((r) => {
        if (!active) return;
        if (source === "companies") setCompanies(r.items || []);
        else setDeals(r.items || []);
      })
      .catch((e) => setError(e.message));
    return () => {
      active = false;
    };
  }, [filter, q, context, source]);

  async function pickCompany(companyId: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const created: any = await api.createInvoiceDealForCompany(companyId);
      await loadDeal(created.dealId);
    } catch (e: any) {
      setError(e.message || "Не удалось создать счёт по компании");
      setBusy(false);
    }
  }

  function edit(patch: Partial<InvoiceEditorInput>) {
    setForm((v) => ({ ...v, ...patch }));
    setDirty(true);
    setIssues({});
  }
  function item(index: number, patch: Partial<InvoiceEditorInput["items"][number]>) {
    edit({ items: form.items.map((r, i) => (i === index ? { ...r, ...patch } : r)) });
  }
  function localCheck() {
    const result = invoiceEditorSchema.safeParse(form);
    if (result.success) return true;
    setIssues(Object.fromEntries(result.error.issues.map((i) => [i.path.join("."), i.message])));
    return false;
  }
  async function save() {
    if (!context || !localCheck()) throw new Error("Проверьте поля документа");
    if (immutable) return doc;
    const result: any = doc
      ? await api.updateInvoiceDraft(doc.id, { ...form, updatedAt: doc.updatedAt })
      : await api.createInvoiceDraft(context.deal.id, { editor: form });
    setDoc(result.invoice);
    setDirty(false);
    window.dispatchEvent(new Event("creolab:attention-changed"));
    if (!id) navigate(`/documents/invoices/${result.invoice.id}`, { replace: true });
    return result.invoice;
  }
  async function action(fn: () => Promise<void>) {
    if (flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message || "Не удалось выполнить действие");
      const fields = documentErrorFields(e, editingBuyer);
      if (Object.keys(fields).length) setIssues(fields);
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  async function issueInvoice() {
    try {
      const record = dirty || !doc ? await save() : doc;
      await api.generateInvoice(record.id);
      const r: any = await api.request(`/api/v1/invoices/${record.id}`);
      setDoc(r.invoice);
      setDirty(false);
      setPreview(null);
      notifySaved("Счёт выставлен");
      window.dispatchEvent(new Event("creolab:attention-changed"));
      navigate("/documents?kind=INVOICE");
    } catch (e) {
      setPreview(null);
      throw e;
    }
  }
  async function saveBuyer() {
    const payload = {
      ...buyer,
      ...(context.company?.iin && !context.company?.bin ? { iin: buyer.bin, bin: null } : {}),
      name: buyer.legalName || buyer.name || context.deal.contactName || "Заказчик",
    };
    if (context.company) await api.request(`/api/v1/companies/${context.company.id}`, { method: "PATCH", body: JSON.stringify(payload) });
    else {
      const result: any = await api.request("/api/v1/companies", { method: "POST", body: JSON.stringify(payload) });
      await api.request(`/api/v1/deals/${context.deal.id}`, { method: "PATCH", body: JSON.stringify({ companyId: result.id }) });
    }
    const updated: any = await api.request(`/api/v1/deals/${context.deal.id}/invoice-context`);
    setContext(updated);
    setEditingBuyer(false);
    setIssues({});
    notifySaved("Реквизиты сохранены в карточке компании");
  }
  const fieldError = (key: string) => (issues[key] ? <span className="error" role="alert">{issues[key]}</span> : null);

  return (
    <section className="avr-editor">
      <div className="row">
        <div>
          <Link to="/documents?kind=INVOICE">Счета</Link>
          <h2>{doc ? `Счёт ${doc.number}` : "Создание счёта на оплату"}</h2>
        </div>
        <span className={`document-status status-${doc?.status || "DRAFT"}`}>{labels[doc?.status || "DRAFT"] || doc?.status}</span>
      </div>
      {error || Object.keys(issues).length ? (
        <div ref={issueSummary} className="panel" role="alert">
          <b>{Object.keys(issues).length ? "Нужно исправить:" : error}</b>
          {error && Object.keys(issues).length && !/^Проверьте поля/.test(error) ? <p>{error}</p> : null}
          <ul>
            {Object.entries(issues).map(([key, message]) => (
              <li key={key}>
                <b>{documentFieldLabel(key)}</b>: {message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!context ? (
        id || params.get("dealId") ? (
          <div className="panel">
            <p>{error || "Загружаем счёт…"}</p>
          </div>
        ) : (
          <div className="panel">
            <h3>Основание счёта</h3>
            <p className="muted">Выберите сделку или компанию. Если сделки ещё нет, она создастся вместе со счётом.</p>
            <div className="actions">
              <button className={source === "deals" ? "btn" : "btn secondary"} onClick={() => { setSource("deals"); setQ(""); }}>
                Сделки
              </button>
              <button className={source === "companies" ? "btn" : "btn secondary"} onClick={() => { setSource("companies"); setQ(""); }}>
                Компании
              </button>
            </div>
            {source === "deals" ? (
              <>
                <div className="actions">
                  <button className={filter === "all" ? "btn" : "btn secondary"} onClick={() => setFilter("all")}>
                    Все сделки
                  </button>
                  <button className={filter === "ready" ? "btn" : "btn secondary"} onClick={() => setFilter("ready")}>
                    Готовы к выставлению
                  </button>
                </div>
                <label>
                  Найти сделку
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название или компания" />
                </label>
                {!deals.length ? <p>Подходящих сделок нет.</p> : null}
                {deals.map((d) => (
                  <div className="card" key={d.id}>
                    <b>
                      {d.title} — {d.companyName || d.contactName}
                    </b>
                    <p>
                      Сделка #{d.number} · {money(d.amount)} ₸ · {d.stage} · {d.responsible || "Ответственный не назначен"}
                    </p>
                    <p className={d.ready ? "ok" : "pdf-import-warnings"}>{d.ready ? "Можно выставить счёт" : d.reasons.join("; ")}</p>
                    <button className="btn secondary" disabled={busy} onClick={() => void loadDeal(d.id)}>
                      {d.invoiceId ? "Открыть счёт" : "Выбрать"}
                    </button>
                  </div>
                ))}
              </>
            ) : (
              <>
                <label>
                  Найти компанию
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название или БИН" />
                </label>
                {!companies.length ? <p>Подходящих компаний нет.</p> : null}
                {companies.map((c) => (
                  <div className="card" key={c.id}>
                    <b>{c.name}</b>
                    <p>
                      {c.bin ? `БИН / ИИН ${c.bin}` : "БИН не указан"}
                      {c.city ? ` · ${c.city}` : ""}
                    </p>
                    <p className="muted">
                      {c.openDealsCount ? `Открытых сделок: ${c.openDealsCount}` : "Открытых сделок нет — сделка создастся вместе со счётом"}
                    </p>
                    <button className="btn" disabled={busy} onClick={() => void pickCompany(c.id)}>
                      Создать счёт
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
        )
      ) : (
        <>
          <div className="panel">
            <div className="row">
              <h3>Основание</h3>
              {!doc ? (
                <button
                  className="btn secondary"
                  disabled={busy}
                  onClick={() => {
                    setContext(null);
                    setForm(empty);
                    setDirty(false);
                  }}
                >
                  Выбрать другое основание
                </button>
              ) : null}
            </div>
            <Link to={`/deals/${context.deal.id}`}>{context.deal.title}</Link>
            <p>
              Сделка #{context.deal.number} · {context.deal.contactName || "Контакт не указан"} · {context.deal.responsible || "Ответственный не назначен"}
            </p>
            <div className="invoice-preview-marks" role="radiogroup" aria-label="Договор">
              <label>
                <input
                  type="radio"
                  name="invoice-contract-basis"
                  disabled={busy || immutable}
                  checked={!form.withoutContract}
                  onChange={() =>
                    edit({
                      withoutContract: false,
                      contractNumber: form.contractNumber || context.contract?.number || "",
                      contractDate: form.contractDate || String(context.contract?.date || "").slice(0, 10),
                    })
                  }
                />{" "}
                По договору
              </label>
              <label>
                <input
                  type="radio"
                  name="invoice-contract-basis"
                  disabled={busy || immutable}
                  checked={Boolean(form.withoutContract)}
                  onChange={() => edit({ withoutContract: true, contractNumber: "", contractDate: "" })}
                />{" "}
                Без договора
              </label>
            </div>
            {form.withoutContract ? (
              <p className="muted">В печатной форме будет указано «без договора», без даты.</p>
            ) : (
              <>
                <label>
                  Номер договора
                  <input
                    maxLength={100}
                    disabled={busy || immutable}
                    aria-invalid={Boolean(issues.contractNumber)}
                    value={form.contractNumber || ""}
                    onChange={(e) => edit({ contractNumber: e.target.value })}
                    placeholder="Например 19122025/01"
                  />
                  {fieldError("contractNumber")}
                </label>
                <label>
                  Дата договора
                  <input type="date" disabled={busy || immutable} aria-invalid={Boolean(issues.contractDate)} value={form.contractDate || ""} onChange={(e) => edit({ contractDate: e.target.value })} />
                  {fieldError("contractDate")}
                </label>
                {context.contract && context.contract.status !== "SIGNED" ? <p className="muted">Договор ещё не подписан. Номер в счёте можно изменить.</p> : null}
              </>
            )}
            <label>
              Дата счёта
              <input type="date" disabled={busy || immutable} aria-invalid={Boolean(issues.documentDate)} value={form.documentDate} onChange={(e) => edit({ documentDate: e.target.value })} />
              {fieldError("documentDate")}
            </label>
            <label>
              К оплате, %
              <input
                type="number"
                min="1"
                max="100"
                step="1"
                disabled={busy || immutable}
                aria-invalid={Boolean(issues.paymentPercent)}
                value={form.paymentPercent}
                onChange={(e) => edit({ paymentPercent: Number(e.target.value) })}
              />
              {fieldError("paymentPercent")}
            </label>
            <p className="muted">100% — полный счёт. 50% — предоплата, как в печатной форме 1С.</p>
          </div>
          <div className="pdf-import-parties">
            <div className="panel">
              <h3>Поставщик</h3>
              {partyFields.map(([k, l]) => (
                <p key={k}>
                  {l}: <b>{context.organization?.[k] || (k === "bin" ? context.organization?.iin : null) || "Не заполнено"}</b>
                  {fieldError(`organization.${k}`)}
                </p>
              ))}
              <p>
                КБе: <b>{context.organization?.kbe || "17"}</b> · КНП: <b>{context.organization?.knp || "859"}</b>
              </p>
              <p>НДС: {context.organization?.vatPayer === true ? "Плательщик НДС" : context.organization?.vatPayer === false ? "Без НДС" : "Не указан"}</p>
              <Link className="btn secondary" to="/settings#company-requisites" target="_blank">
                Заполнить данные
              </Link>
              <button
                className="btn secondary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const r: any = await api.request(`/api/v1/deals/${context.deal.id}/invoice-context`);
                    setContext(r);
                  })
                }
              >
                Обновить реквизиты
              </button>
            </div>
            <div className="panel">
              <h3>Покупатель</h3>
              <p>Контактное лицо: {context.deal.contactName || "Не указано"}</p>
              {partyFields.map(([k, l]) =>
                editingBuyer ? (
                  <label key={k}>
                    {l}
                    <input value={buyer[k] || ""} onChange={(e) => setBuyer((v) => ({ ...v, [k]: e.target.value }))} />
                    {fieldError(`customer.${k}`)}
                  </label>
                ) : (
                  <p key={k}>
                    {l}: <b>{context.company?.[k] || (k === "legalName" ? context.company?.name : k === "bin" ? context.company?.iin : null) || "Не заполнено"}</b>
                    {fieldError(`customer.${k}`)}
                  </p>
                ),
              )}
              {fieldError("customer.company")}
              {editingBuyer ? (
                <button className="btn" disabled={busy} onClick={() => void action(saveBuyer)}>
                  Сохранить в компании
                </button>
              ) : (
                <button
                  className="btn secondary"
                  disabled={busy || immutable}
                  onClick={() => {
                    setBuyer(Object.fromEntries(partyFields.map(([k]) => [k, context.company?.[k] || (k === "legalName" ? context.company?.name : k === "bin" ? context.company?.iin : "") || ""])));
                    setEditingBuyer(true);
                  }}
                >
                  Заполнить данные
                </button>
              )}
            </div>
          </div>
          <div className="panel">
            <h3>Позиции счёта</h3>
            {fieldError("deal.items")}
            {form.items.map((r, i) => (
              <fieldset disabled={busy || immutable} className="avr-line" key={i}>
                <label>
                  Работа / услуга
                  <input aria-invalid={Boolean(issues[`items.${i}.name`])} value={r.name} onChange={(e) => item(i, { name: e.target.value })} />
                  {fieldError(`items.${i}.name`)}
                </label>
                <label>
                  Количество
                  <input type="number" min="0.001" step="0.001" aria-invalid={Boolean(issues[`items.${i}.quantity`])} value={r.quantity} onChange={(e) => item(i, { quantity: Number(e.target.value) })} />
                  {fieldError(`items.${i}.quantity`)}
                </label>
                <label>
                  Ед. изм.
                  <EsfMeasureUnitSelect aria-label={`Единица измерения ${i + 1}`} invalid={Boolean(issues[`items.${i}.unit`])} value={r.unit} onChange={(unit) => item(i, { unit })} />
                  {fieldError(`items.${i}.unit`)}
                </label>
                <label>
                  Цена без НДС
                  <input type="number" min="0" step="0.01" aria-invalid={Boolean(issues[`items.${i}.unitPrice`])} value={r.unitPrice} onChange={(e) => item(i, { unitPrice: Number(e.target.value) })} />
                  {fieldError(`items.${i}.unitPrice`)}
                </label>
                <label>
                  НДС, %
                  <input type="number" min="0" max="100" step="0.01" aria-invalid={Boolean(issues[`items.${i}.vatRate`])} value={r.vatRate} onChange={(e) => item(i, { vatRate: Number(e.target.value) })} />
                  {fieldError(`items.${i}.vatRate`)}
                </label>
                <p>{money(totals?.items.rows[i]?.totalAmount)} ₸</p>
                <button className="btn secondary" onClick={() => edit({ items: form.items.filter((_, n) => n !== i) })}>
                  Удалить
                </button>
              </fieldset>
            ))}
            <button
              className="btn secondary"
              disabled={busy || immutable}
              onClick={() =>
                edit({
                  items: [...form.items, { name: "", quantity: 1, unit: ESF_DEFAULT_MEASURE_UNIT_CODE, unitPrice: 0, vatRate: Number(context.organization?.defaultVatRate || 0) }],
                })
              }
            >
              + Добавить позицию
            </button>
            <p>
              Позиции: {money(totals?.items.totals.totalAmount)} ₸
              {form.paymentPercent < 100 ? ` · предоплата ${form.paymentPercent}%: ${money(totals?.payable.totalAmount)} ₸` : null} ·{" "}
              <b>К оплате: {money(totals?.payable.totalAmount)} ₸</b>
            </p>
            {fieldError("")}
            <button
              className="btn"
              disabled={busy || immutable}
              onClick={() =>
                void action(async () => {
                  await save();
                  notifySaved("Черновик счёта сохранён");
                })
              }
            >
              Сохранить черновик
            </button>
          </div>
          <div className="panel">
            <h3>Печатная форма</h3>
            <p className="muted">Счёт собирается по форме 1С. Сформируйте PDF, сверьте реквизиты и сумму, затем выставьте счёт.</p>
            <div className="actions">
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    const record = await save();
                    setPreview({ id: record.id, stamped: false });
                  })
                }
              >
                Сформировать счёт
              </button>
            </div>
          </div>
          {preview ? (
            <div className="stats-modal-backdrop" onClick={() => setPreview(null)}>
              <div className="stats-modal invoice-preview-modal" onClick={(e) => e.stopPropagation()}>
                <div className="row">
                  <h3>Счёт {doc?.number || ""}</h3>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || immutable || doc?.importedPdf}
                    title={doc?.importedPdf ? "Загруженный PDF уже сохранён в исходном виде" : undefined}
                    onClick={() => void action(issueInvoice)}
                  >
                    Выставить счёт
                  </button>
                </div>
                <div className="invoice-preview-marks">
                  <label>
                    <input
                      type="radio"
                      name="invoice-mark"
                      checked={!preview.stamped}
                      onChange={() => setPreview({ ...preview, stamped: false })}
                    />{" "}
                    Без подписи и печати
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="invoice-mark"
                      checked={preview.stamped}
                      onChange={() => setPreview({ ...preview, stamped: true })}
                    />{" "}
                    С подписью и печатью
                  </label>
                </div>
                {preview.stamped && !(context.organization?.hasStamp || context.organization?.hasSignature) ? (
                  <p className="muted">
                    Загрузите печать и подпись в{" "}
                    <Link to="/settings#company-requisites" target="_blank">
                      реквизитах компании
                    </Link>
                    , затем обновите реквизиты на этой странице.
                  </p>
                ) : null}
                {previewError ? <p className="error">{previewError}</p> : null}
                {previewUrl ? (
                  <PdfDocumentViewer title="Просмотр счёта" src={previewUrl} />
                ) : previewError ? null : (
                  <p className="muted">Готовим PDF…</p>
                )}
                <div className="actions">
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy || !previewUrl}
                    onClick={() =>
                      void action(async () => {
                        await downloadInvoicePdf(preview.id, preview.stamped);
                        notifySaved("PDF счёта скачан");
                      })
                    }
                  >
                    Скачать
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || immutable || doc?.importedPdf}
                    title={doc?.importedPdf ? "Загруженный PDF уже сохранён в исходном виде" : undefined}
                    onClick={() => void action(issueInvoice)}
                  >
                    Выставить счёт
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
