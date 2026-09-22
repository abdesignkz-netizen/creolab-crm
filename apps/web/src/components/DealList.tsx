import { Link } from "react-router-dom";
import { useUrlState } from "../lib/useUrlState";
import { phoneText } from "../lib/contactDisplay";
import { Pagination } from "./Pagination";

const KINDS = [["CONTRACT", "Договор"], ["AVR", "АВР"], ["INVOICE", "Счёт"], ["ESF", "ЭСФ"]] as const;
const OUTCOME: Record<string, string> = { open: "В работе", won: "Успешно завершена", lost: "Потеряна", on_hold: "На паузе" };
const PAYMENT: Record<string, string> = { NOT_REQUIRED: "Оплата не требуется", NOT_INVOICED: "Счёт не выставлен", INVOICED: "Ожидается оплата", PARTIALLY_PAID: "Частично оплачено", PAID: "Оплачено", OVERDUE: "Оплата просрочена", CANCELLED: "Оплата отменена" };
const DOCUMENT_FILTERS = ["all", "no_contract", "no_invoice", "avr_unsent", "esf_unsent", "errors"] as const;

export function DealList({ items, documentsAllowed, onOpenContract }: { items: any[]; documentsAllowed: boolean; onOpenContract: (id: string) => void }) {
  const [q, setQ] = useUrlState<string>("q", "");
  const [sort, setSort] = useUrlState<string>("sort", "newest", ["newest", "oldest", "amount_desc", "amount_asc"]);
  const [docFilter, setDocFilter] = useUrlState<string>("document", "all", DOCUMENT_FILTERS);
  const [offset, setOffset] = useUrlState<string>("offset", "0");
  const needle = q.trim().toLocaleLowerCase("ru");
  const digits = needle.replace(/\D/g, "");
  const filtered = items.filter((deal) => {
    const haystack = [deal.number, deal.title, deal.company?.name, deal.contact?.name, deal.contact?.phone, ...(deal.items || []).map((item: any) => item.name)].join(" ").toLocaleLowerCase("ru");
    if (needle && !haystack.includes(needle) && !(digits.length >= 4 && String(deal.contact?.phone || "").replace(/\D/g, "").includes(digits))) return false;
    if (!documentsAllowed || docFilter === "all") return true;
    if (!deal.documents) return false;
    if (docFilter === "no_contract") return !deal.documents.CONTRACT;
    if (docFilter === "no_invoice") return !deal.documents.INVOICE;
    if (docFilter === "errors") return Object.values(deal.documents).some((doc: any) => doc?.status === "ERROR");
    const doc = deal.documents[docFilter === "avr_unsent" ? "AVR" : "ESF"];
    return !doc || doc.delivery === "not_sent";
  }).sort((a, b) => {
    if (sort.startsWith("amount")) {
      if (a.amount == null || b.amount == null) return a.amount == null ? b.amount == null ? 0 : 1 : -1;
      return sort === "amount_asc" ? a.amount - b.amount : b.amount - a.amount;
    }
    return (sort === "oldest" ? 1 : -1) * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) || String(a.id).localeCompare(String(b.id));
  });
  const limit = 50;
  const start = Math.min(Math.max(0, Math.floor((Number(offset) || 0) / limit) * limit), Math.max(0, Math.ceil(filtered.length / limit) - 1) * limit);
  function documentCell(deal: any, kind: string, label: string) {
    if (!deal.documents) return <span className="muted">Нет данных</span>;
    const doc = deal.documents[kind];
    if (!doc) return <span className="deal-doc-empty">Не создан</span>;
    const tone = doc.status === "ERROR" ? "error" : doc.delivery === "sent" ? "sent" : "pending";
    return <div className="deal-doc-summary">
      {kind === "CONTRACT" ? <button type="button" className="deal-doc-link" aria-label={`Открыть договор ${doc.number}`} onClick={() => onOpenContract(doc.id)}>{doc.number}</button> : <Link className="deal-doc-link" to={doc.href} aria-label={`Открыть ${label}: ${doc.number}`}>{doc.number}</Link>}
      <span className={`deal-doc-state ${tone}`}>{doc.statusLabel}</span>
      <span className="deal-doc-delivery">{doc.deliveryLabel}</span>
      {doc.count > 1 ? <small className="muted">Последний из {doc.count}</small> : null}
    </div>;
  }
  return <div className="deal-list stack">
    <div className="deal-list-tools">
      <label className="deal-list-search">Поиск<input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Номер сделки, компания, телефон или заказ" /></label>
      {documentsAllowed ? <label>Документы<select aria-label="Документы" value={docFilter} onChange={(event) => setDocFilter(event.target.value)}>
        <option value="all">Все документы</option><option value="no_contract">Без договора</option><option value="no_invoice">Без счёта</option><option value="avr_unsent">АВР не создан / не отправлен</option><option value="esf_unsent">ЭСФ не создан / не отправлен</option><option value="errors">Ошибки документов</option>
      </select></label> : null}
      <label>Порядок<select aria-label="Порядок" value={sort} onChange={(event) => setSort(event.target.value)}><option value="newest">Сначала новые</option><option value="oldest">Сначала старые</option><option value="amount_desc">Сумма: по убыванию</option><option value="amount_asc">Сумма: по возрастанию</option></select></label>
    </div>
    {documentsAllowed ? <p className="muted deal-list-hint">Показан последний документ каждого вида. Статус документа и его отправка указаны отдельно. Скачивание файла или создание ссылки на подпись не подтверждает отправку клиенту.</p> : null}
    <Pagination total={filtered.length} offset={start} limit={limit} onChange={(value) => setOffset(String(value))} />
    <div className="panel deal-list-scroll">
      <table className="deal-list-table">
        <thead><tr><th scope="col">№ сделки</th><th scope="col">Компания / клиент</th><th scope="col">Телефон</th><th scope="col">Заказ</th><th scope="col">Сумма заказа</th><th scope="col">Статус сделки</th>{documentsAllowed ? KINDS.map(([kind, label]) => <th scope="col" key={kind}>{label}</th>) : null}</tr></thead>
        <tbody>{filtered.slice(start, start + limit).map((deal) => <tr key={deal.id}>
          <td data-label="№ сделки"><Link className="deal-number-link" to={`/deals/${deal.id}`}>{deal.number || "Открыть сделку"}</Link><small className="muted">{deal.createdAt ? new Date(deal.createdAt).toLocaleDateString("ru-RU") : ""}</small></td>
          <td data-label="Компания / клиент">{deal.company ? <Link to={`/companies/${deal.company.id}`}>{deal.company.name}</Link> : <span>{deal.contact?.name || "Клиент не указан"}</span>}{deal.company && deal.contact?.name ? <small className="muted">{deal.contact.name}</small> : null}{!deal.company ? <small className="muted">Без компании</small> : null}</td>
          <td data-label="Телефон">{deal.contact?.phone ? <a className="deal-phone" href={`tel:${String(deal.contact.phone).replace(/[^\d+]/g, "")}`}>{phoneText(deal.contact.phone)}</a> : <span className="muted">Не указан</span>}</td>
          <td data-label="Заказ"><Link to={`/deals/${deal.id}`}><b>{deal.title}</b></Link>{deal.items?.length ? <small className="muted">{deal.items.slice(0, 2).map((item: any) => item.name).join(" · ")}{deal.items.length > 2 ? ` · ещё ${deal.items.length - 2}` : ""}</small> : null}</td>
          <td data-label="Сумма заказа"><strong className="deal-list-amount">{deal.amountLabel || "Не указана"}</strong><small className={deal.paymentStatus === "OVERDUE" ? "error" : "muted"}>{PAYMENT[deal.paymentStatus] || deal.paymentStatus}</small></td>
          <td data-label="Статус сделки"><span className={`deal-outcome ${deal.outcome}`}>{OUTCOME[deal.outcome] || deal.outcome}</span><small>{deal.stage?.name || "Этап не указан"}</small>{deal.assigneeName ? <small className="muted">{deal.assigneeName}</small> : null}</td>
          {documentsAllowed ? KINDS.map(([kind, label]) => <td data-label={label} key={kind}>{documentCell(deal, kind, label)}</td>) : null}
        </tr>)}</tbody>
      </table>
      {!filtered.length ? <p className="state">Сделок по выбранным условиям нет.</p> : null}
    </div>
    {filtered.length > limit ? <Pagination total={filtered.length} offset={start} limit={limit} onChange={(value) => setOffset(String(value))} /> : null}
  </div>;
}
