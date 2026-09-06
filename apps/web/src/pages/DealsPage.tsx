import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";

type Scope = "all" | "mine" | "unassigned";

function Flag({ on, label }: { on?: boolean; label: string }) {
  if (!on) return null;
  return <span className="deal-flag">{label}</span>;
}

export function DealsPage() {
  const navigate = useNavigate();
  const [scope, setScope] = useState<Scope>("all");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  async function load(nextScope = scope) {
    try {
      setData(await api.deals({ scope: nextScope }));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  useEffect(() => {
    void load();
  }, [scope]);

  async function onDrop(stageId: string) {
    if (!dragId || busy) return;
    setBusy(true);
    try {
      await api.changeDealStage(dragId, { stageId });
      setDragId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось переместить");
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) return <div className="state">Загрузка…</div>;
  if (!data) {
    return (
      <section>
        <p className="error">{error}</p>
        <button type="button" className="btn" onClick={() => void load()}>
          Повторить
        </button>
      </section>
    );
  }

  const s = data.summary;

  return (
    <section className="deals-page">
      <div className="page-head">
        <div>
          <p className="page-kicker">Воронка продаж</p>
          <h2>Сделки</h2>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="sit-kpi-grid deals-summary">
        <div className="sit-kpi">
          <span className="muted">Активные</span>
          <strong>{s.activeDeals}</strong>
        </div>
        <div className="sit-kpi">
          <span className="muted">Потенциальный pipeline</span>
          <strong>{s.pipelineAmountLabel || "—"}</strong>
          {s.amountKnownOf ? (
            <span className="kpi-hint">
              сумма у {s.amountKnownCount} из {s.amountKnownOf}
            </span>
          ) : null}
        </div>
        <div className="sit-kpi">
          <span className="muted">Взвешенный прогноз</span>
          <strong>{s.weightedPipelineLabel || "—"}</strong>
        </div>
        <div className="sit-kpi">
          <span className="muted">Ожидаемые оплаты</span>
          <strong>{s.expectedPaymentsLabel || "—"}</strong>
        </div>
      </div>

      <div className="segmented sit-scope" style={{ width: "fit-content" }}>
        {(
          [
            ["all", "Все"],
            ["mine", "Мои"],
            ["unassigned", "Без ответственного"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={scope === value ? "btn" : "btn secondary"}
            onClick={() => setScope(value)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="deal-kanban">
        {(data.columns || []).map((col: any) => (
          <div
            key={col.stageId}
            className="deal-column"
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => void onDrop(col.stageId)}
          >
            <div className="deal-column-head">
              <b>{col.name}</b>
              <span className="muted">
                {col.count} · {col.amountLabel || "без сумм"}
              </span>
            </div>
            <div className="deal-column-body">
              {col.deals.map((deal: any) => (
                <article
                  key={deal.id}
                  className={`deal-card${dragId === deal.id ? " dragging" : ""}`}
                  draggable
                  onDragStart={() => setDragId(deal.id)}
                  onDragEnd={() => setDragId(null)}
                  onClick={() => navigate(`/deals/${deal.id}`)}
                >
                  <b>{deal.title}</b>
                  <div className="muted">{deal.contact?.name || "Клиент"}</div>
                  <div className="deal-card-meta">
                    <span>{deal.amountLabel || "сумма не указана"}</span>
                    <span>{deal.probability}%</span>
                  </div>
                  <div className="muted">На этапе: {deal.stageDurationLabel}</div>
                  {deal.nextAction ? (
                    <div className="deal-next">След.: {deal.nextAction}</div>
                  ) : (
                    <div className="deal-next warn">Нет следующего шага</div>
                  )}
                  {deal.assigneeName ? <div className="muted">{deal.assigneeName}</div> : null}
                  <div className="deal-flags">
                    <Flag on={deal.flags?.needsReply} label="Нужен ответ" />
                    <Flag on={deal.flags?.overdueTask} label="Просрочено" />
                    <Flag on={deal.flags?.noNextAction} label="Без шага" />
                    <Flag on={deal.flags?.waitingClient} label="Ждём клиента" />
                    <Flag on={deal.flags?.stalled} label="Зависла" />
                  </div>
                </article>
              ))}
              {col.deals.length === 0 ? <p className="empty">Пусто</p> : null}
            </div>
          </div>
        ))}
      </div>

      {data.onHold?.length ? (
        <div className="sit-section">
          <h3>Отложено (ON HOLD)</h3>
          {data.onHold.map((deal: any) => (
            <Link key={deal.id} className="sit-list-row" to={`/deals/${deal.id}`}>
              <div>
                <b>{deal.title}</b>
                <div className="muted">{deal.contact?.name}</div>
              </div>
              <span className="muted">{deal.amountLabel || "—"}</span>
            </Link>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function DealDetailPage() {
  const { dealId } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [amount, setAmount] = useState("");
  const [probability, setProbability] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("NOT_INVOICED");
  const [lossReason, setLossReason] = useState("Дорого");
  const [busy, setBusy] = useState(false);
  const [board, setBoard] = useState<any>(null);

  async function load() {
    if (!dealId) return;
    try {
      const [detail, boardData] = await Promise.all([api.deal(dealId), api.deals()]);
      setData(detail);
      setBoard(boardData);
      const d = (detail as any).deal;
      setAmount(d.amount != null ? String(d.amount) : "");
      setProbability(String(d.probability ?? 10));
      setNextAction(d.nextAction || "");
      setPaymentStatus(d.paymentStatus || "NOT_INVOICED");
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  useEffect(() => {
    void load();
  }, [dealId]);

  async function save() {
    if (!dealId) return;
    setBusy(true);
    try {
      await api.updateDeal(dealId, {
        offerAmountMinor: amount === "" ? null : Number(amount),
        probability: Number(probability),
        nextAction: nextAction || null,
        paymentStatus,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не сохранено");
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) return <div className="state">Загрузка…</div>;
  if (!data) {
    return (
      <section>
        <p className="error">{error}</p>
        <Link to="/deals">К воронке</Link>
      </section>
    );
  }

  const d = data.deal;

  return (
    <section className="deal-detail">
      <div className="page-head">
        <div>
          <p className="page-kicker">
            <Link to="/deals">Сделки</Link>
          </p>
          <h2>{d.title}</h2>
          <p className="muted">
            {d.contact?.name} · {d.stage?.name} · {d.outcome}
          </p>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}

      <div className="sit-kpi-grid">
        <div className="sit-kpi">
          <span className="muted">Сумма</span>
          <strong>{d.amountLabel || "—"}</strong>
        </div>
        <div className="sit-kpi">
          <span className="muted">Вероятность</span>
          <strong>{d.probability}%</strong>
        </div>
        <div className="sit-kpi">
          <span className="muted">На этапе</span>
          <strong>{d.stageDurationLabel}</strong>
        </div>
        <div className="sit-kpi">
          <span className="muted">Оплата</span>
          <strong>{d.paymentStatus}</strong>
        </div>
      </div>

      <div className="panel deal-edit">
        <b>Редактирование</b>
        <label>
          Сумма (₸)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="пусто = неизвестна" />
        </label>
        <label>
          Вероятность %
          <input value={probability} onChange={(e) => setProbability(e.target.value)} type="number" min={0} max={100} />
        </label>
        <label>
          Следующий шаг
          <input value={nextAction} onChange={(e) => setNextAction(e.target.value)} />
        </label>
        <label>
          Статус оплаты
          <select value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)}>
            {(board?.paymentStatuses || ["NOT_INVOICED", "INVOICED", "PAID"]).map((s: string) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
            Сохранить
          </button>
          {d.contact?.id ? (
            <Link className="btn secondary" to={`/contacts/${d.contact.id}`}>
              Клиент
            </Link>
          ) : null}
          {d.inquiryId ? (
            <Link className="btn secondary" to={`/requests/${d.inquiryId}`}>
              Заявка
            </Link>
          ) : null}
        </div>
      </div>

      <div className="panel">
        <b>Перевести на стадию</b>
        <div className="deal-stage-actions">
          {(board?.columns || []).map((col: any) => (
            <button
              key={col.stageId}
              type="button"
              className={col.stageId === d.stageId ? "btn" : "btn secondary"}
              disabled={busy || col.stageId === d.stageId}
              onClick={() => {
                setBusy(true);
                void api
                  .changeDealStage(d.id, { stageId: col.stageId })
                  .then(() => load())
                  .catch((err) => setError(err instanceof Error ? err.message : "Ошибка"))
                  .finally(() => setBusy(false));
              }}
            >
              {col.name}
            </button>
          ))}
        </div>
      </div>

      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={busy || d.outcome === "won"}
          onClick={() => {
            setBusy(true);
            void api
              .markDealWon(d.id, { wonAmountMinor: d.amount })
              .then(() => load())
              .catch((err) => setError(err instanceof Error ? err.message : "Ошибка"))
              .finally(() => setBusy(false));
          }}
        >
          WON
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api
              .holdDeal(d.id, d.outcome !== "on_hold")
              .then(() => load())
              .catch((err) => setError(err instanceof Error ? err.message : "Ошибка"))
              .finally(() => setBusy(false));
          }}
        >
          {d.outcome === "on_hold" ? "Снять с hold" : "ON HOLD"}
        </button>
        <select value={lossReason} onChange={(e) => setLossReason(e.target.value)}>
          {(board?.lostReasons || ["Дорого", "Другое"]).map((r: string) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn danger"
          disabled={busy || d.outcome === "lost"}
          onClick={() => {
            setBusy(true);
            void api
              .markDealLost(d.id, { lossReason })
              .then(() => load())
              .catch((err) => setError(err instanceof Error ? err.message : "Ошибка"))
              .finally(() => setBusy(false));
          }}
        >
          LOST
        </button>
        <button type="button" className="btn secondary" onClick={() => navigate("/tasks")}>
          Задачи
        </button>
      </div>

      <div className="panel">
        <b>История стадий</b>
        {(data.stageHistory || []).length === 0 ? <p className="empty">Пока нет</p> : null}
        {(data.stageHistory || []).map((h: any) => (
          <div className="row" key={h.id}>
            <div>
              <b>
                {h.fromSystemKey || "—"} → {h.toSystemKey}
              </b>
              <div className="muted">{new Date(h.enteredAt).toLocaleString("ru-RU")}</div>
            </div>
          </div>
        ))}
      </div>

      {d.tasks?.length ? (
        <div className="panel">
          <b>Открытые задачи</b>
          {d.tasks.map((t: any) => (
            <div className="row" key={t.id}>
              <div>
                <b>{t.title}</b>
                <div className="muted">{t.dueAt ? new Date(t.dueAt).toLocaleString("ru-RU") : "без срока"}</div>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
