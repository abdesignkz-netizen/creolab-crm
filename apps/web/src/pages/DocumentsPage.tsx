import { ContractWorkspaceModal } from "../components/ContractWorkspaceModal";
import { ManualPdfImportPanel } from "./ManualPdfImportPanel";
import { ContractTemplatePanel } from "./ContractTemplatePanel";
import { DeleteContractButton } from "../components/DeleteContractButton";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Pagination } from "../components/Pagination";
import { api } from "../lib/api";
import { useRequestVersion, useUrlState } from "../lib/useUrlState";

const KINDS = [
  ["", "Все"],
  ["CONTRACT", "Договоры"],
  ["INVOICE", "Счета"],
  ["AVR", "АВР"],
  ["ESF", "ЭСФ"],
] as const;

const STATUS_FILTERS: Record<string, Array<[string, string]>> = {
  CONTRACT: [
    ["DRAFT", "Черновик"],
    ["READY_TO_SIGN", "Сформирован"],
    ["PENDING_SIGNATURE", "На подписи"],
    ["PARTIALLY_SIGNED", "Частично подписан"],
    ["SIGNED", "Подписан"],
  ],
  INVOICE: [
    ["DRAFT", "Черновик"],
    ["ISSUED", "Выставлен"],
    ["PARTIALLY_PAID", "Частично оплачен"],
    ["PAID", "Оплачен"],
    ["OVERDUE", "Просрочен"],
    ["CANCELLED", "Отменён"],
  ],
  AVR: [
    ["DRAFT", "Черновик"],
    ["VALIDATED", "Готов"],
    ["SIGNED", "Подписан"],
    ["SENT", "Отправлен"],
    ["ACCEPTED", "Принят"],
    ["ERROR", "Ошибка"],
  ],
  ESF: [
    ["DRAFT", "Черновик"],
    ["VALIDATED", "Готов"],
    ["SIGNED", "Подписан"],
    ["SENT", "Отправлен"],
    ["ACCEPTED", "Принят"],
    ["ERROR", "Ошибка"],
  ],
};

export function DocumentsPage() {
  const requestVersion = useRequestVersion();
  const [searchParams, setSearchParams] = useSearchParams();
  const [kind] = useUrlState<(typeof KINDS)[number][0]>("kind", "", KINDS.map(([value]) => value));
  const statusAllowed = ["", ...(STATUS_FILTERS[kind] || []).map(([value]) => value)] as const;
  const [status, setStatus] = useUrlState<string>("status", "", statusAllowed);
  const [attention] = useUrlState<"" | "1">("attention", "", ["", "1"]);
  const [q, setQ] = useState("");
  const [offset, setOffset] = useUrlState<string>("offset", "0");
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<any>({});
  const [error, setError] = useState("");
  const [disabled, setDisabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [commandText, setCommandText] = useState(searchParams.get("command") || "");
  const [commandParse, setCommandParse] = useState<any>(null);
  const [commandDealId, setCommandDealId] = useState("");
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandResult, setCommandResult] = useState<any>(null);
  const [esfCreateOpen, setEsfCreateOpen] = useState(false);
  const [esfDeals, setEsfDeals] = useState<any[]>([]);
  const [esfDealId, setEsfDealId] = useState("");
  const [esfBusy, setEsfBusy] = useState(false);
  const [esfError, setEsfError] = useState("");
  const [createdEsf, setCreatedEsf] = useState<any>(null);
  const esfFlight = useRef(false);
  const selectedContractId = searchParams.get("contract");
  const dealFilter = searchParams.get("dealId") || "";
  function contractHref(id: string) {
    const params = new URLSearchParams(searchParams); params.set("contract", id);
    return `/documents?${params}`;
  }
  function closeContract() {
    setSearchParams(previous => { const params = new URLSearchParams(previous); params.delete("contract"); return params; }, { replace: true });
  }
  const limit = 50;

  async function openEsfCreate() {
    setEsfCreateOpen(true);
    setEsfBusy(true);
    setEsfError("");
    try {
      const result: any = await api.request("/api/v1/documents/avr/eligible-deals?filter=all");
      setEsfDeals(result.items || []);
    } catch (err) {
      setEsfError(err instanceof Error ? err.message : "Не удалось загрузить сделки");
    } finally { setEsfBusy(false); }
  }

  async function createEsf(e: FormEvent) {
    e.preventDefault();
    if (!esfDealId || esfFlight.current) return;
    esfFlight.current = true;
    setEsfBusy(true);
    setEsfError("");
    try {
      const result: any = await api.createElectronicDocumentDraft(esfDealId, { type: "ESF" });
      setCreatedEsf(result.document);
      setEsfCreateOpen(false);
      showKind("ESF");
      window.dispatchEvent(new Event("creolab:attention-changed"));
      await load(0);
    } catch (err) {
      setEsfError(err instanceof Error ? err.message : "Не удалось создать ЭСФ");
    } finally { esfFlight.current = false; setEsfBusy(false); }
  }


  async function load(nextOffset = Number(offset) || 0) {
    const version = ++requestVersion.current;
    try {
      setLoading(true);
      const data: any = await api.documents({
        kind: kind || undefined,
        dealId: dealFilter || undefined,
        attention: attention === "1" ? "1" : undefined,
        status: status || undefined,
        q: q.trim() || undefined,
        offset: String(nextOffset),
        limit: String(limit),
      });
      if (version !== requestVersion.current) return;
      setItems(data.items || []);
      setTotal(Number(data.total || 0));
      setCounts(data.counts || {});
      setDisabled(false);
      setError("");
    } catch (err: any) {
      if (version !== requestVersion.current) return;
      if (err?.status === 403 && err?.body?.code === "documents_disabled") {
        setDisabled(true);
        setItems([]);
        setTotal(0);
        setError("");
      } else {
        setError(err instanceof Error ? err.message : "Ошибка");
      }
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(Number(offset) || 0);
  }, [kind, attention, status, offset, dealFilter]);

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    setOffset("0");
    await load(0);
  }

  async function parseCommand() {
    if (!commandText.trim()) return;
    setCommandBusy(true);
    setCommandResult(null);
    try {
      const data: any = await api.parseTaskCommand({ text: commandText.trim() });
      setCommandParse(data);
      const firstDeal = data.document?.deals?.[0]?.id || "";
      setCommandDealId(data.document?.deals?.length === 1 ? firstDeal : "");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось понять команду");
    } finally {
      setCommandBusy(false);
    }
  }

  function showKind(nextKind: (typeof KINDS)[number][0]) {
    setSearchParams((previous) => {
      const result = new URLSearchParams(previous);
      result.delete("offset");
      result.delete("attention");
      result.delete("status");
      if (!nextKind) result.delete("kind");
      else result.set("kind", nextKind);
      return result;
    }, { replace: true });
  }

  async function runCommand() {
    if (!commandText.trim()) return;
    setCommandBusy(true);
    try {
      const result: any = await api.createDocumentFromCommand({
        text: commandText.trim(),
        action: commandParse?.command?.documentAction,
        dealId: commandDealId || undefined,
      });
      setCommandResult(result);
      setError("");
      const action = String(result.action || commandParse?.command?.documentAction || "");
      if (action === "generate_invoice") showKind("INVOICE");
      else if (action === "generate_contract" || action === "send_for_sign") showKind("CONTRACT");
      else if (action === "create_avr" || action === "validate_avr" || action === "send_avr") showKind("AVR");
      else if (action === "create_esf" || action === "validate_esf" || action === "send_esf") showKind("ESF");
      window.dispatchEvent(new Event("creolab:attention-changed"));
      await load(0);
    } catch (err: any) {
      const details = err?.body?.details;
      if (Array.isArray(details?.deals) && details.deals.length) {
        setCommandParse({
          ...(commandParse || {}),
          document: { ...(commandParse?.document || {}), deals: details.deals },
        });
      }
      setError(err instanceof Error ? err.message : "Не удалось выполнить команду");
    } finally {
      setCommandBusy(false);
    }
  }

  useEffect(() => {
    if (searchParams.get("command")?.trim()) void parseCommand();
  }, []);

  return (
    <section className="documents-page">
      {dealFilter ? <div className="active-filter-note"><span>Документы выбранной сделки</span><Link to={`/deals/${dealFilter}`}>Открыть сделку</Link><button type="button" className="btn secondary" onClick={() => setSearchParams(previous => { const next = new URLSearchParams(previous); next.delete("dealId"); next.delete("offset"); return next; })}>Показать все документы</button></div> : null}
      <div className="row sit-head">
        <div>
          <h2>Документы</h2>
          <p className="muted">Договоры, счета, АВР и ЭСФ по всем сделкам</p>
        </div>
        <Link className="btn secondary" to="/settings#company-requisites">
          Реквизиты
        </Link>
      </div>

      {!disabled ? (
        <div className="documents-start-grid">
          <ContractTemplatePanel onSaved={() => void load()} />
          <ManualPdfImportPanel onSaved={() => void load()} />
        </div>
      ) : null}

      <form
        className="panel command-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void parseCommand();
        }}
      >
        <div className="command-compose-head">
          <b>Что сделать</b>
          <p className="muted">Например: сформировать договор, проверить АВР, отправить ЭСФ.</p>
        </div>
        <textarea
          value={commandText}
          onChange={(e) => setCommandText(e.target.value)}
          rows={2}
          placeholder="Сформируй договор по сделке …"
        />
        <div className="actions">
          <button type="submit" className="btn secondary" disabled={commandBusy || !commandText.trim()}>
            Разобрать
          </button>
          <button
            type="button"
            className="btn"
            disabled={
              commandBusy ||
              !commandText.trim() ||
              (Boolean(commandParse) && commandParse.command?.intent !== "document_action") ||
              (commandParse?.command?.intent === "document_action" &&
                !commandDealId &&
                (commandParse?.document?.deals || []).length !== 1)
            }
            onClick={() => void runCommand()}
          >
            Сделать
          </button>
        </div>
        {commandParse?.command?.intent === "document_action" ? (
          <div className="command-understanding" style={{ marginTop: 12 }}>
            <div className="muted">{commandParse.understanding?.action}</div>
            <p className="muted">{commandParse.understanding?.consequence}</p>
            {(commandParse.document?.deals || []).length > 1 ? (
              <label>
                Сделка
                <select value={commandDealId} onChange={(e) => setCommandDealId(e.target.value)}>
                  <option value="">Выберите сделку</option>
                  {(commandParse.document.deals as Array<{ id: string; title: string }>).map((deal) => (
                    <option key={deal.id} value={deal.id}>
                      {deal.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : commandParse.document?.deals?.[0] ? (
              <p>
                <Link to={commandParse.document.deals[0].href}>{commandParse.document.deals[0].title}</Link>
              </p>
            ) : null}
          </div>
        ) : commandParse ? (
          <p className="muted">
            Это не команда по документам.{" "}
            <Link to={`/tasks?command=${encodeURIComponent(commandText)}`}>Открыть в задачах</Link>
          </p>
        ) : null}
        {commandResult?.deal?.id ? (
          <p>
            {commandResult.prepareOnly ? "Черновик готов. " : "Готово. "}
            {commandResult.result?.invoice?.id ? (
              <Link to={`/documents/invoices/${commandResult.result.invoice.id}`}>Открыть счёт</Link>
            ) : commandResult.result?.contract?.id ? (
              <Link to={contractHref(commandResult.result.contract.id)}>Открыть договор</Link>
            ) : (
              <Link to={`/deals/${commandResult.deal.id}`}>Открыть сделку</Link>
            )}
          </p>
        ) : null}
      </form>

      <div className="sit-toolbar">
        <div className="sit-periods">
          {KINDS.map(([id, label]) => (
            <button
              key={id || "all"}
              type="button"
              className={kind === id && attention !== "1" ? "btn sit-chip" : "btn secondary sit-chip"}
              onClick={() => showKind(id)}
            >
              {label}
              {id === "CONTRACT" && counts.contract ? ` · ${counts.contract}` : ""}
              {id === "INVOICE" && counts.invoice ? ` · ${counts.invoice}` : ""}
              {id === "AVR" && counts.avr ? ` · ${counts.avr}` : ""}
              {id === "ESF" && counts.esf ? ` · ${counts.esf}` : ""}
            </button>
          ))}
          <button
            type="button"
            className={attention === "1" ? "btn sit-chip" : "btn secondary sit-chip"}
            onClick={() => {
              setSearchParams((previous) => {
                const result = new URLSearchParams(previous);
                result.delete("offset");
                result.delete("kind");
                if (previous.get("attention") === "1") result.delete("attention");
                else result.set("attention", "1");
                return result;
              }, { replace: true });
            }}
          >
            Требуют внимания{counts.attention ? ` · ${counts.attention}` : ""}
          </button>
        </div>
        <form className="companies-search" onSubmit={onSearch}>
          {STATUS_FILTERS[kind] ? (
            <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Статус">
              <option value="">Все статусы</option>
              {STATUS_FILTERS[kind].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          ) : null}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Номер, сделка, компания или БИН"
          />
          <button type="submit" className="btn secondary">
            Найти
          </button>
        </form>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {disabled ? (
        <div className="sit-section">
          <p className="empty">
            Контур документов выключен. Включите черновики в{" "}
            <Link to="/settings">настройках реквизитов</Link>.
          </p>
        </div>
      ) : null}
      {loading ? <div className="state">Загрузка…</div> : null}

      {!disabled ? <div className="sit-section">
        {kind === "INVOICE" || kind === "AVR" || kind === "ESF" ? <div className="row sit-head">
          <h3>{kind === "INVOICE" ? "Счета" : kind === "AVR" ? "АВР" : "ЭСФ"}</h3>
          {kind === "INVOICE"
            ? <Link className="btn" to="/documents/invoices/new">Создать счёт</Link>
            : kind === "AVR"
            ? <Link className="btn" to="/documents/avr/new">Создать АВР</Link>
            : <button type="button" className="btn" disabled={esfBusy} onClick={() => void openEsfCreate()}>Создать ЭСФ</button>}
        </div> : null}
        {kind === "ESF" && esfCreateOpen ? <form className="panel" onSubmit={createEsf}>
          <label>Сделка для ЭСФ
            <select value={esfDealId} disabled={esfBusy} onChange={e => setEsfDealId(e.target.value)}>
              <option value="">Выберите сделку</option>
              {esfDeals.map(deal => <option key={deal.id} value={deal.id}>{deal.title} — {deal.companyName || deal.contactName}</option>)}
            </select>
          </label>
          {!esfBusy && !esfDeals.length && !esfError ? <p className="muted">Нет сделок для создания ЭСФ.</p> : null}
          {esfError ? <p className="error" role="alert">{esfError}</p> : null}
          <div className="actions">
            <button type="submit" className="btn" disabled={esfBusy || !esfDealId}>Создать черновик ЭСФ</button>
            <button type="button" className="btn secondary" disabled={esfBusy} onClick={() => setEsfCreateOpen(false)}>Отмена</button>
          </div>
        </form> : null}
        {kind === "ESF" && createdEsf ? <p role="status">ЭСФ {createdEsf.number} сохранён. <Link to={`/deals/${createdEsf.dealId}#esf`}>Открыть ЭСФ</Link></p> : null}
        {!loading && !items.length ? <p className="empty">{kind === "INVOICE" ? "Счетов пока нет. Нажмите «Создать счёт»." : kind === "AVR" ? "АВР пока нет. Нажмите «Создать АВР»." : kind === "ESF" ? "ЭСФ пока нет. Нажмите «Создать ЭСФ»." : "Документов пока нет. Загрузите документ или создайте его в карточке сделки."}</p> : null}
        {items.length > 0 ? (
          <div className="documents-table-wrap">
            <table className={`documents-table${kind ? " documents-table-kind-filtered" : ""}`}>
              <colgroup>
                <col className="documents-col-number" />
                <col className="documents-col-client" />
                <col className="documents-col-deal" />
                <col className="documents-col-amount" />
                <col className="documents-col-date" />
                {kind ? null : <col className="documents-col-kind" />}
                <col className="documents-col-status" />
                {kind === "AVR" ? null : <col className="documents-col-avr" />}
                {kind === "ESF" ? null : <col className="documents-col-esf" />}
                <col className="documents-col-owner" />
                <col className="documents-col-actions" />
              </colgroup>
              <thead>
                <tr>
                  <th>№ документа</th>
                  <th>Клиент</th>
                  <th>Сделка</th>
                  <th>Сумма</th>
                  <th>Дата</th>
                  {kind ? null : <th>Тип</th>}
                  <th>Статус</th>
                  {kind === "AVR" ? null : <th>АВР</th>}
                  {kind === "ESF" ? null : <th>ЭСФ</th>}
                  <th>Ответственный</th>
                  <th>Действия</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={`${item.kind}-${item.id}`}>
                    <td className="documents-cell-number">
                      <Link to={item.kind === "CONTRACT" ? contractHref(item.id) : item.href}>{item.number}</Link>
                    </td>
                    <td className="documents-cell-client">{item.companyName || "Не указан"}</td>
                    <td className="documents-cell-deal">
                      <Link to={`/deals/${item.dealId}`}>{item.dealTitle}</Link>
                    </td>
                    <td className="documents-cell-amount">{Number(item.totalAmount).toLocaleString("ru-RU")} ₸</td>
                    <td className="documents-cell-date">{new Date(item.date || item.updatedAt).toLocaleDateString("ru-RU")}</td>
                    {kind ? null : <td className="documents-cell-kind">{item.kindLabel}</td>}
                    <td className="documents-cell-status">
                      <span className={`document-status status-${item.errorCode ? "ERROR" : item.status}`}>{item.statusLabel}</span>
                    </td>
                    {kind === "AVR" ? null : <td className="documents-cell-avr">{item.avrStatus || "Требуется"}</td>}
                    {kind === "ESF" ? null : <td className="documents-cell-esf">{item.esfStatus}</td>}
                    <td className="documents-cell-owner">{item.responsible || "Не назначен"}</td>
                    <td className="documents-cell-actions">
                      <Link to={item.kind === "CONTRACT" ? contractHref(item.id) : item.href}>Открыть</Link>
                      {item.kind === "CONTRACT" ? (
                        <DeleteContractButton
                          id={item.id}
                          number={item.number}
                          onDeleted={async () => {
                            setOffset("0");
                            await load(0);
                          }}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div> : null}

      {!disabled && total > 0 ? (
        <Pagination
          total={total}
          offset={Number(offset) || 0}
          limit={limit}
          loading={loading}
          onChange={(next) => setOffset(String(next))}
        />
      ) : null}
      {selectedContractId ? <ContractWorkspaceModal key={selectedContractId} contractId={selectedContractId} onClose={closeContract} onChanged={() => load()} /> : null}
    </section>
  );
}
