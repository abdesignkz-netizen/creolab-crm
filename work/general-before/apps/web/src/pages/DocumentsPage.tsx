import { useEffect, useState, type FormEvent } from "react";
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

export function DocumentsPage() {
  const requestVersion = useRequestVersion();
  const [searchParams] = useSearchParams();
  const [kind, setKind] = useUrlState("kind", "");
  const [attention, setAttention] = useUrlState("attention", "");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useUrlState("offset", "0");
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
  const limit = 50;

  async function load(nextOffset = Number(offset) || 0) {
    const version = ++requestVersion.current;
    try {
      setLoading(true);
      const data: any = await api.documents({
        kind: kind || undefined,
        attention: attention === "1" ? "1" : undefined,
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
  }, [kind, attention, offset]);

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
      await load(Number(offset) || 0);
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
      <div className="row sit-head">
        <div>
          <h2>Документы</h2>
          <p className="muted">Договоры, счета, АВР и ЭСФ по всем сделкам</p>
        </div>
        <Link className="btn secondary" to="/settings">
          Реквизиты
        </Link>
      </div>

      <form
        className="panel command-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void parseCommand();
        }}
      >
        <div className="command-compose-head">
          <b>Команда по документам</b>
          <p className="muted">«Сформируй договор по сделке …», «Проверь АВР», «Отправь ЭСФ в ИС ЭСФ».</p>
        </div>
        <textarea
          value={commandText}
          onChange={(e) => setCommandText(e.target.value)}
          rows={2}
          placeholder="Сформируй договор по сделке Phase11 документы"
        />
        <div className="actions">
          <button type="submit" className="btn secondary" disabled={commandBusy || !commandText.trim()}>
            Понять
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
            Выполнить
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
            <Link to={`/deals/${commandResult.deal.id}`}>Открыть сделку</Link>
          </p>
        ) : null}
      </form>

      <div className="sit-toolbar">
        <div className="sit-periods">
          {KINDS.map(([id, label]) => (
            <button
              key={id || "all"}
              type="button"
              className={kind === id ? "btn sit-chip" : "btn secondary sit-chip"}
              onClick={() => {
                setKind(id);
                setOffset("0");
              }}
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
              setAttention(attention === "1" ? "" : "1");
              setOffset("0");
            }}
          >
            Требуют внимания{counts.attention ? ` · ${counts.attention}` : ""}
          </button>
        </div>
        <form className="companies-search" onSubmit={onSearch}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Номер, сделка или компания"
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

      {!loading && !disabled && !items.length ? (
        <div className="sit-section">
          <p className="empty">Документов пока нет. Создайте договор в карточке сделки.</p>
        </div>
      ) : null}

      <div className="documents-list">
        {items.map((item) => (
          <Link key={`${item.kind}-${item.id}`} to={item.href} className="sit-list-row">
            <div>
              <b>
                {item.kindLabel} {item.number}
              </b>
              <div className="muted">
                {item.dealTitle}
                {item.companyName ? ` · ${item.companyName}` : ""}
              </div>
            </div>
            <div className="documents-row-meta">
              <span className={item.attention ? "deal-flag" : "muted"}>{item.statusLabel}</span>
              <span className="muted">
                {Number(item.totalAmount || 0).toLocaleString("ru-RU")} {item.currency || "KZT"}
              </span>
            </div>
          </Link>
        ))}
      </div>

      {!disabled ? (
        <Pagination
          total={total}
          offset={Number(offset) || 0}
          limit={limit}
          loading={loading}
          onChange={(next) => setOffset(String(next))}
        />
      ) : null}
    </section>
  );
}
