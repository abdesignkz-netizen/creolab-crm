import { uiMessage, uiText, useUiText, localizeUiOptions, uiFormatLocale } from "../lib/uiText";
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

const money = (v: unknown) => Number(v || 0).toLocaleString(uiFormatLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const empty: InvoiceEditorInput = {
  documentDate: new Date().toISOString().slice(0, 10),
  paymentPercent: 100,
  paymentKind: "FULL",
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
  const uiText = useUiText();
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
        if (live) setPreviewError(err instanceof Error ? err.message : uiText("Не удалось открыть счёт"));
      });
    return () => {
      live = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [preview]);
  const immutable = Boolean(doc && (doc.importedPdf || !["DRAFT", "ISSUED"].includes(doc.status)));
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
              number: record.number,
              documentDate: String(record.date || record.documentDate || ctx.editor?.documentDate || empty.documentDate).slice(0, 10),
              paymentPercent: record.paymentPercent || ctx.editor?.paymentPercent || 100,
              paymentKind: record.paymentKind || ctx.editor?.paymentKind || (record.paymentPercent && record.paymentPercent < 100 ? "PREPAYMENT" : "FULL"),
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
      setError(e.message || uiText("Не удалось создать счёт по компании"));
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
    setIssues(Object.fromEntries(result.error.issues.map((i) => [i.path.join("."), uiMessage(i.message)])));
    return false;
  }
  async function save() {
    if (!context || !localCheck()) throw new Error(uiText("Проверьте поля документа"));
    if (immutable) return doc;
    const result: any = doc
      ? await api.updateInvoiceDraft(doc.id, { ...form, updatedAt: doc.updatedAt })
      : await api.createInvoiceDraft(context.deal.id, { editor: form });
    setDoc(result.invoice);
    setForm(current => ({ ...current, number: result.invoice.number }));
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
      setError(e.message || uiText("Не удалось выполнить действие"));
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
      notifySaved(uiText("Счёт выставлен"));
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
    notifySaved(uiText("Реквизиты сохранены в карточке компании"));
  }
  const fieldError = (key: string) => (issues[key] ? <span className="error" role="alert">{issues[key]}</span> : null);

  return (
    <section className="avr-editor">
      <div className="row">
        <div>
          <Link to="/documents?kind=INVOICE">{uiText("Счета")}</Link>
          <h2>{doc ? uiText("Счёт {p0}", {p0: doc.number}) : uiText("Создание счёта на оплату")}</h2>
        </div>
        <span className={`document-status status-${doc?.status || "DRAFT"}`}>{localizeUiOptions(labels, uiText)[doc?.status || "DRAFT"] || doc?.status}</span>
      </div>
      {error || Object.keys(issues).length ? (
        <div ref={issueSummary} className="panel" role="alert">
          <b>{Object.keys(issues).length ? uiText("Нужно исправить:") : error}</b>
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
            <p>{error || uiText("Загружаем счёт…")}</p>
          </div>
        ) : (
          <div className="panel">
            <h3>{uiText("Основание счёта")}</h3>
            <p className="muted">{uiText("Выберите сделку или компанию. Если сделки ещё нет, она создастся вместе со счётом.")}</p>
            <div className="actions">
              <button className={source === "deals" ? "btn" : "btn secondary"} onClick={() => { setSource("deals"); setQ(""); }}>
                {uiText("Сделки")}</button>
              <button className={source === "companies" ? "btn" : "btn secondary"} onClick={() => { setSource("companies"); setQ(""); }}>
                {uiText("Компании")}</button>
            </div>
            {source === "deals" ? (
              <>
                <div className="actions">
                  <button className={filter === "all" ? "btn" : "btn secondary"} onClick={() => setFilter("all")}>
                    {uiText("Все сделки")}</button>
                  <button className={filter === "ready" ? "btn" : "btn secondary"} onClick={() => setFilter("ready")}>
                    {uiText("Готовы к выставлению")}</button>
                </div>
                <label>
                  {uiText("Найти сделку")}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder={uiText("Название или компания")} />
                </label>
                {!deals.length ? <p>{uiText("Подходящих сделок нет.")}</p> : null}
                {deals.map((d) => (
                  <div className="card" key={d.id}>
                    <b>
                      {d.title} — {d.companyName || d.contactName}
                    </b>
                    <p>
                      {uiText("Сделка #")}{d.number} · {money(d.amount)} ₸ · {d.stage} · {d.responsible || uiText("Ответственный не назначен")}
                    </p>
                    <p className={d.ready ? "ok" : "pdf-import-warnings"}>{d.ready ? uiText("Можно выставить счёт") : d.reasons.map((reason: string) => uiMessage(reason)).join("; ")}</p>
                    <button className="btn secondary" disabled={busy} onClick={() => void loadDeal(d.id)}>
                      {d.invoiceId ? uiText("Открыть счёт") : uiText("Выбрать")}
                    </button>
                  </div>
                ))}
              </>
            ) : (
              <>
                <label>
                  {uiText("Найти компанию")}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder={uiText("Название или БИН")} />
                </label>
                {!companies.length ? <p>{uiText("Подходящих компаний нет.")}</p> : null}
                {companies.map((c) => (
                  <div className="card" key={c.id}>
                    <b>{c.name}</b>
                    <p>
                      {c.bin ? uiText("БИН / ИИН {p0}", {p0: c.bin}) : uiText("БИН не указан")}
                      {c.city ? ` · ${c.city}` : ""}
                    </p>
                    <p className="muted">
                      {c.openDealsCount ? uiText("Открытых сделок: {p0}", {p0: c.openDealsCount}) : uiText("Открытых сделок нет — сделка создастся вместе со счётом")}
                    </p>
                    <button className="btn" disabled={busy} onClick={() => void pickCompany(c.id)}>
                      {uiText("Создать счёт")}</button>
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
              <h3>{uiText("Основание")}</h3>
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
                  {uiText("Выбрать другое основание")}</button>
              ) : null}
            </div>
            <Link to={`/deals/${context.deal.id}`}>{context.deal.title}</Link>
            <p>
              {uiText("Сделка #")}{context.deal.number} · {context.deal.contactName || uiText("Контакт не указан")} · {context.deal.responsible || uiText("Ответственный не назначен")}
            </p>
            <div className="invoice-preview-marks" role="radiogroup" aria-label={uiText("Договор")}>
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
                {uiText("По договору")}</label>
              <label>
                <input
                  type="radio"
                  name="invoice-contract-basis"
                  disabled={busy || immutable}
                  checked={Boolean(form.withoutContract)}
                  onChange={() => edit({ withoutContract: true, contractNumber: "", contractDate: "" })}
                />{" "}
                {uiText("Без договора")}</label>
            </div>
            {form.withoutContract ? (
              <p className="muted">{uiText("В печатной форме будет указано «без договора», без даты.")}</p>
            ) : (
              <>
                <label>
                  {uiText("Номер договора")}<input
                    maxLength={100}
                    disabled={busy || immutable}
                    aria-invalid={Boolean(issues.contractNumber)}
                    value={form.contractNumber || ""}
                    onChange={(e) => edit({ contractNumber: e.target.value })}
                    placeholder={uiText("Например 19122025/01")}
                  />
                  {fieldError("contractNumber")}
                </label>
                <label>
                  {uiText("Дата договора")}<input type="date" disabled={busy || immutable} aria-invalid={Boolean(issues.contractDate)} value={form.contractDate || ""} onChange={(e) => edit({ contractDate: e.target.value })} />
                  {fieldError("contractDate")}
                </label>
                {context.contract && context.contract.status !== "SIGNED" ? <p className="muted">{uiText("Договор ещё не подписан. Номер в счёте можно изменить.")}</p> : null}
              </>
            )}
            {doc?.importedPdf ? <p className="muted">{uiText("Загруженный PDF сохраняется в исходном виде. Для изменения данных создайте новый документ.")}</p> : null}
            <label>
              {uiText("Номер счёта")}<input disabled={busy || immutable} maxLength={40} aria-invalid={Boolean(issues.number)} value={form.number || ""} placeholder={uiText("Автоматически по настройкам нумерации")} onChange={(e) => edit({ number: e.target.value })} />
              {fieldError("number")}
            </label>
            <label>
              {uiText("Дата счёта")}<input type="date" disabled={busy || immutable} aria-invalid={Boolean(issues.documentDate)} value={form.documentDate} onChange={(e) => edit({ documentDate: e.target.value })} />
              {fieldError("documentDate")}
            </label>
            <label>
              {uiText("Доля счёта, %")}<input
                type="number"
                min="10"
                max="100"
                step="10"
                disabled={busy || immutable}
                aria-invalid={Boolean(issues.paymentPercent)}
                value={form.paymentPercent}
                onChange={(e) => edit({ paymentPercent: Number(e.target.value) })}
              />
              {fieldError("paymentPercent")}
            </label>
            <label>
              {uiText("Назначение платежа")}<select disabled={busy || immutable} value={form.paymentKind} onChange={(e) => edit({ paymentKind: e.target.value as InvoiceEditorInput["paymentKind"] })}>
                <option value="FULL">{uiText("Полный счёт")}</option>
                <option value="PREPAYMENT">{uiText("Предоплата")}</option>
                <option value="BALANCE">{uiText("Остаток")}</option>
              </select>
            </label>
            <p className="muted">{uiText("Укажите долю от 10 до 100% с шагом 10. Например, 30% предоплата или 70% остаток.")}</p>
          </div>
          <div className="pdf-import-parties">
            <div className="panel">
              <h3>{uiText("Поставщик")}</h3>
              {localizeUiOptions(partyFields, uiText).map(([k, l]) => (
                <p key={k}>
                  {l}: <b>{context.organization?.[k] || (k === "bin" ? context.organization?.iin : null) || uiText("Не заполнено")}</b>
                  {fieldError(`organization.${k}`)}
                </p>
              ))}
              <p>
                {uiText("КБе:")}{" "}<b>{context.organization?.kbe || "17"}</b> {" "}{uiText("· КНП:")}{" "}<b>{context.organization?.knp || "859"}</b>
              </p>
              <p>{uiText("НДС:")}{" "}{context.organization?.vatPayer === true ? uiText("Плательщик НДС") : context.organization?.vatPayer === false ? uiText("Без НДС") : uiText("Не указан")}</p>
              <Link className="btn secondary" to="/settings#company-requisites" target="_blank">
                {uiText("Заполнить данные")}</Link>
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
                {uiText("Обновить реквизиты")}</button>
            </div>
            <div className="panel">
              <h3>{uiText("Покупатель")}</h3>
              <p>{uiText("Контактное лицо:")}{" "}{context.deal.contactName || uiText("Не указано")}</p>
              {localizeUiOptions(partyFields, uiText).map(([k, l]) =>
                editingBuyer ? (
                  <label key={k}>
                    {l}
                    <input value={buyer[k] || ""} onChange={(e) => setBuyer((v) => ({ ...v, [k]: e.target.value }))} />
                    {fieldError(`customer.${k}`)}
                  </label>
                ) : (
                  <p key={k}>
                    {l}: <b>{context.company?.[k] || (k === "legalName" ? context.company?.name : k === "bin" ? context.company?.iin : null) || uiText("Не заполнено")}</b>
                    {fieldError(`customer.${k}`)}
                  </p>
                ),
              )}
              {fieldError("customer.company")}
              {editingBuyer ? (
                <button className="btn" disabled={busy} onClick={() => void action(saveBuyer)}>
                  {uiText("Сохранить в компании")}</button>
              ) : (
                <button
                  className="btn secondary"
                  disabled={busy || immutable}
                  onClick={() => {
                    setBuyer(Object.fromEntries(localizeUiOptions(partyFields, uiText).map(([k]) => [k, context.company?.[k] || (k === "legalName" ? context.company?.name : k === "bin" ? context.company?.iin : "") || ""])));
                    setEditingBuyer(true);
                  }}
                >
                  {uiText("Заполнить данные")}</button>
              )}
            </div>
          </div>
          <div className="panel">
            <h3>{uiText("Позиции счёта")}</h3>
            {fieldError("deal.items")}
            {form.items.map((r, i) => (
              <fieldset disabled={busy || immutable} className="avr-line" key={i}>
                <label>
                  {uiText("Работа / услуга")}<input aria-invalid={Boolean(issues[`items.${i}.name`])} value={r.name} onChange={(e) => item(i, { name: e.target.value })} />
                  {fieldError(`items.${i}.name`)}
                </label>
                <label>
                  {uiText("Количество")}<input type="number" min="0.001" step="0.001" aria-invalid={Boolean(issues[`items.${i}.quantity`])} value={r.quantity} onChange={(e) => item(i, { quantity: Number(e.target.value) })} />
                  {fieldError(`items.${i}.quantity`)}
                </label>
                <label>
                  {uiText("Ед. изм.")}<EsfMeasureUnitSelect aria-label={uiText("Единица измерения {p0}", {p0: i + 1})} invalid={Boolean(issues[`items.${i}.unit`])} value={r.unit} onChange={(unit) => item(i, { unit })} />
                  {fieldError(`items.${i}.unit`)}
                </label>
                <label>
                  {uiText("Цена без НДС")}<input type="number" min="0" step="0.01" aria-invalid={Boolean(issues[`items.${i}.unitPrice`])} value={r.unitPrice} onChange={(e) => item(i, { unitPrice: Number(e.target.value) })} />
                  {fieldError(`items.${i}.unitPrice`)}
                </label>
                <label>
                  {uiText("НДС, %")}<input type="number" min="0" max="100" step="0.01" aria-invalid={Boolean(issues[`items.${i}.vatRate`])} value={r.vatRate} onChange={(e) => item(i, { vatRate: Number(e.target.value) })} />
                  {fieldError(`items.${i}.vatRate`)}
                </label>
                <p>{money(totals?.items.rows[i]?.totalAmount)} ₸</p>
                <button className="btn secondary" onClick={() => edit({ items: form.items.filter((_, n) => n !== i) })}>
                  {uiText("Удалить")}</button>
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
              {uiText("+ Добавить позицию")}</button>
            <p>
              {uiText("Позиции:")}{" "}{money(totals?.items.totals.totalAmount)} ₸
              {form.paymentPercent < 100 ? ` · ${form.paymentKind === "BALANCE" ? uiText("остаток") : uiText("предоплата")} ${form.paymentPercent}%: ${money(totals?.payable.totalAmount)} ₸` : null} ·{" "}
              <b>{uiText("К оплате:")}{" "}{money(totals?.payable.totalAmount)} ₸</b>
            </p>
            {fieldError("")}
            <button
              className="btn"
              disabled={busy || immutable}
              onClick={() =>
                void action(async () => {
                  await save();
                  notifySaved(uiText("Черновик счёта сохранён"));
                })
              }
            >
              {uiText("Сохранить черновик")}</button>
          </div>
          <div className="panel">
            <h3>{uiText("Печатная форма")}</h3>
            <p className="muted">{uiText("Счёт собирается по форме 1С. Сформируйте PDF, сверьте реквизиты и сумму, затем выставьте счёт.")}</p>
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
                {uiText("Сформировать счёт")}</button>
            </div>
          </div>
          {preview ? (
            <div className="stats-modal-backdrop" onClick={() => setPreview(null)}>
              <div className="stats-modal invoice-preview-modal" onClick={(e) => e.stopPropagation()}>
                <div className="row">
                  <h3>{uiText("Счёт")}{" "}{doc?.number || ""}</h3>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || immutable || doc?.importedPdf}
                    title={doc?.importedPdf ? uiText("Загруженный PDF уже сохранён в исходном виде") : undefined}
                    onClick={() => void action(issueInvoice)}
                  >
                    {uiText("Выставить счёт")}</button>
                </div>
                <div className="invoice-preview-marks">
                  <label>
                    <input
                      type="radio"
                      name="invoice-mark"
                      checked={!preview.stamped}
                      onChange={() => setPreview({ ...preview, stamped: false })}
                    />{" "}
                    {uiText("Без подписи и печати")}</label>
                  <label>
                    <input
                      type="radio"
                      name="invoice-mark"
                      checked={preview.stamped}
                      onChange={() => setPreview({ ...preview, stamped: true })}
                    />{" "}
                    {uiText("С подписью и печатью")}</label>
                </div>
                {preview.stamped && !(context.organization?.hasStamp || context.organization?.hasSignature) ? (
                  <p className="muted">
                    {uiText("Загрузите печать и подпись в")}{" "}
                    <Link to="/settings#company-requisites" target="_blank">
                      {uiText("реквизитах компании")}</Link>
                    {uiText(", затем обновите реквизиты на этой странице.")}</p>
                ) : null}
                {previewError ? <p className="error">{previewError}</p> : null}
                {previewUrl ? (
                  <PdfDocumentViewer title={uiText("Просмотр счёта")} src={previewUrl} />
                ) : previewError ? null : (
                  <p className="muted">{uiText("Готовим PDF…")}</p>
                )}
                <div className="actions">
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busy || !previewUrl}
                    onClick={() =>
                      void action(async () => {
                        await downloadInvoicePdf(preview.id, preview.stamped);
                        notifySaved(uiText("PDF счёта скачан"));
                      })
                    }
                  >
                    {uiText("Скачать")}</button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || immutable || doc?.importedPdf}
                    title={doc?.importedPdf ? uiText("Загруженный PDF уже сохранён в исходном виде") : undefined}
                    onClick={() => void action(issueInvoice)}
                  >
                    {uiText("Выставить счёт")}</button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
