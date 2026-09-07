import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

type Filter =
  | "all"
  | "ai"
  | "human"
  | "intervention"
  | "waiting_client"
  | "approvals"
  | "problems";

function phoneText(item: { phone?: string | null }) {
  return item.phone || "Нет телефона";
}

export function ControlPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busyKey, setBusyKey] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [confirmPause, setConfirmPause] = useState(false);
  const [confirmClaimAll, setConfirmClaimAll] = useState(false);

  async function load() {
    try {
      const overview = await api.managementOverview();
      setData(overview);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка загрузки");
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  async function run(key: string, action: () => Promise<any>) {
    setBusyKey(key);
    setError("");
    try {
      const result = await action();
      if (result?.note) setNote(result.note);
      else if (result?.sellerError) setNote(result.sellerError);
      else if (result?.appliedOnSeller === false) setNote("Режим записан в CRM. На AI Manager не применилось.");
      else setNote("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Команда не выполнена");
    } finally {
      setBusyKey("");
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

  const ai = data.ai || {};
  const showInterventions = filter === "all" || filter === "intervention";
  const showWaiting = filter === "all" || filter === "intervention";
  const showApprovals = filter === "all" || filter === "approvals";
  const showAiList = filter === "all" || filter === "ai";
  const showHumanList = filter === "all" || filter === "human";
  const showProblems = filter === "all" || filter === "problems";
  const showWaitingClient = filter === "waiting_client";

  return (
    <section className="management-page">
      <div className="page-head">
        <div>
          <h2>Управление</h2>
          <p className="muted">Оперативный контроль AI Manager и передачи диалогов сотрудникам.</p>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {note ? <p className="ok">{note}</p> : null}

      <div className="panel management-ai-status">
        <div className="management-ai-status-head">
          <div>
            <b>AI Manager</b>
            <span className={`mgmt-dot ${ai.statusTone === "ok" ? "ok" : "warn"}`} />
            <span>{ai.status}</span>
          </div>
          <span className="muted">Обновлено: {ai.updatedAtLabel || "—"}</span>
        </div>
        <p className="muted">{ai.note}</p>
        <div className="mgmt-metrics">
          <div>
            <b>{ai.aiControlled ?? 0}</b>
            <span>AI ведёт</span>
          </div>
          <div>
            <b>{ai.humanControlled ?? 0}</b>
            <span>Ведут сотрудники</span>
          </div>
          <div>
            <b>{ai.waitingClient ?? 0}</b>
            <span>Ждём клиента</span>
          </div>
          <div>
            <b>{ai.needsIntervention ?? 0}</b>
            <span>Нужно вмешательство</span>
          </div>
          <div>
            <b>{ai.pendingApprovals ?? 0}</b>
            <span>Ожидают подтверждения</span>
          </div>
          <div>
            <b>{ai.problems ?? 0}</b>
            <span>Проблемы</span>
          </div>
        </div>
        <div className="actions">
          {!ai.paused ? (
            <button type="button" className="btn secondary" onClick={() => setConfirmPause(true)} disabled={busyKey === "pause"}>
              Приостановить AI
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={busyKey === "pause"}
              onClick={() => run("pause", () => api.setAiManagerPause(false))}
            >
              Возобновить AI
            </button>
          )}
          <button type="button" className="btn secondary" onClick={() => setConfirmClaimAll(true)} disabled={busyKey === "claim-all"}>
            Забрать все диалоги у AI
          </button>
          <Link className="btn secondary" to="/integrations">
            Открыть интеграции
          </Link>
        </div>
      </div>

      {confirmPause ? (
        <div className="panel soft">
          <b>Приостановить AI Manager?</b>
          <p className="muted">
            AI Manager перестанет автоматически отвечать клиентам в активных диалогах. Входящие сообщения и заявки
            продолжат поступать и сохраняться в CRM.
          </p>
          <div className="actions">
            <button type="button" className="btn secondary" onClick={() => setConfirmPause(false)}>
              Отмена
            </button>
            <button
              type="button"
              className="btn"
              disabled={busyKey === "pause"}
              onClick={() => {
                setConfirmPause(false);
                void run("pause", () => api.setAiManagerPause(true));
              }}
            >
              Приостановить
            </button>
          </div>
        </div>
      ) : null}

      {confirmClaimAll ? (
        <div className="panel soft">
          <b>Забрать все диалоги у AI?</b>
          <p className="muted">
            AI сейчас ведёт {ai.aiControlled ?? 0} активных диалогов. После подтверждения автоматические ответы в этих
            диалогах будут остановлены и управление будет передано сотрудникам. Ответственные за сделки не меняются.
          </p>
          <div className="actions">
            <button type="button" className="btn secondary" onClick={() => setConfirmClaimAll(false)}>
              Отмена
            </button>
            <button
              type="button"
              className="btn"
              disabled={busyKey === "claim-all"}
              onClick={() => {
                setConfirmClaimAll(false);
                void run("claim-all", () => api.claimAllAiConversations());
              }}
            >
              Забрать все
            </button>
          </div>
        </div>
      ) : null}

      <div className="chip-row" style={{ marginBottom: 12 }}>
        {(
          [
            ["all", "Все"],
            ["intervention", "Нужно вмешательство"],
            ["ai", "AI ведёт"],
            ["human", "Человек ведёт"],
            ["waiting_client", "Ждём клиента"],
            ["approvals", "Ожидают подтверждения"],
            ["problems", "Проблемы"],
          ] as Array<[Filter, string]>
        ).map(([id, label]) => (
          <button key={id} type="button" className={filter === id ? "chip active" : "chip"} onClick={() => setFilter(id)}>
            {label}
          </button>
        ))}
      </div>

      {showInterventions ? (
        <div className="panel">
          <div className="mgmt-section-head">
            <h3>Требует вмешательства</h3>
            <span className="muted">{(data.interventions || []).length}</span>
          </div>
          {(data.interventions || []).length === 0 ? (
            <p className="empty">Сейчас AI Manager не требует вмешательства.</p>
          ) : (
            (data.interventions || []).map((item: any) => (
              <div className="mgmt-card" key={item.id}>
                <div>
                  <b>
                    {[item.companyName, item.contactName].filter(Boolean).join(" · ")}
                  </b>
                  <div className="muted">{phoneText(item)}</div>
                  <div className="muted">
                    {[item.topic, item.budgetLabel, item.stageLabel].filter(Boolean).join(" · ")}
                  </div>
                  <p>
                    <b>Почему требуется человек</b>
                    <br />
                    {item.reasonLabel}
                    {item.summary ? ` — ${item.summary}` : ""}
                  </p>
                  {item.recentMessages?.length ? (
                    <div className="mgmt-messages">
                      {item.recentMessages.map((m: any) => (
                        <div key={m.id} className="muted">
                          {m.actor} · {m.atLabel}: {m.text}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busyKey === item.id}
                    onClick={() => run(item.id, () => api.takeConversation(item.id))}
                  >
                    Забрать себе
                  </button>
                  <Link className="btn secondary" to={`/conversations/${item.id}`}>
                    Открыть диалог
                  </Link>
                  {item.dealId ? (
                    <Link className="btn secondary" to={`/deals/${item.dealId}`}>
                      Открыть сделку
                    </Link>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}

      {showWaiting ? (
        <div className="panel">
          <div className="mgmt-section-head">
            <h3>Ждут менеджера</h3>
            <span className="muted">{(data.waitingForManager || []).length}</span>
          </div>
          {(data.waitingForManager || []).length === 0 ? (
            <p className="empty">Нет клиентов, ожидающих менеджера.</p>
          ) : (
            (data.waitingForManager || []).map((item: any) => (
              <div className="mgmt-card compact" key={`wait-${item.id}`}>
                <div>
                  <b>
                    {item.contactName}
                    {item.companyName ? ` · ${item.companyName}` : ""}
                  </b>
                  <div className="muted">{phoneText(item)}</div>
                  <div className="muted">
                    Ждёт {item.waitLabel || "—"} · {item.reasonLabel}
                  </div>
                  <div className="muted">{[item.topic, item.budgetLabel, item.stageLabel].filter(Boolean).join(" · ")}</div>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busyKey === `wait-${item.id}`}
                    onClick={() => run(`wait-${item.id}`, () => api.takeConversation(item.id))}
                  >
                    Забрать
                  </button>
                  <Link className="btn secondary" to={`/conversations/${item.id}`}>
                    Открыть
                  </Link>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}

      {showApprovals ? (
        <div className="panel">
          <div className="mgmt-section-head">
            <h3>Ожидают подтверждения</h3>
            <span className="muted">{(data.pendingApprovals || []).length}</span>
          </div>
          {(data.pendingApprovals || []).length === 0 ? (
            <p className="empty">Нет действий AI, ожидающих подтверждения.</p>
          ) : (
            (data.pendingApprovals || []).map((item: any) => (
              <div className="mgmt-card compact" key={item.id}>
                <div>
                  <b>
                    {item.actionLabel}
                    {item.contactName ? ` · ${item.contactName}` : ""}
                  </b>
                  <div className="muted">
                    {[phoneText(item), item.companyName, item.topic, item.channel].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <div className="actions">
                  <Link className="btn" to={item.href || "/tasks"}>
                    Проверить
                  </Link>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}

      {showAiList || showWaitingClient ? (
        <div className="panel">
          <div className="mgmt-section-head">
            <h3>{showWaitingClient ? "Ждём клиента" : "AI сейчас ведёт"}</h3>
            <span className="muted">
              {showWaitingClient ? ai.waitingClient ?? 0 : (data.aiConversations || []).length}
            </span>
          </div>
          {(showWaitingClient
            ? (data.aiConversations || []).filter((i: any) => i.waitingFor === "CLIENT").concat(
                (data.humanConversations || []).filter((i: any) => i.waitingFor === "CLIENT"),
              )
            : data.aiConversations || []
          ).length === 0 ? (
            <p className="empty">{showWaitingClient ? "Никто не ждёт клиента." : "AI сейчас не ведёт активных диалогов."}</p>
          ) : (
            <div className="mgmt-table">
              {(showWaitingClient
                ? [...(data.aiConversations || []), ...(data.humanConversations || [])].filter(
                    (i: any) => i.waitingFor === "CLIENT",
                  )
                : data.aiConversations || []
              ).map((item: any) => (
                <Link key={item.id} className="mgmt-row" to={`/conversations/${item.id}`}>
                  <span>{item.contactName}</span>
                  <span className="muted">{phoneText(item)}</span>
                  <span className="muted">{item.topic}</span>
                  <span className="muted">{item.stageLabel || item.modeLabel}</span>
                  <span className="muted">{item.activityLabel || "—"}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {showHumanList ? (
        <div className="panel">
          <div className="mgmt-section-head">
            <h3>Ведут сотрудники</h3>
            <span className="muted">{(data.humanConversations || []).length}</span>
          </div>
          {(data.humanConversations || []).length === 0 ? (
            <p className="empty">Нет диалогов у сотрудников.</p>
          ) : (
            <div className="mgmt-table">
              {(data.humanConversations || []).map((item: any) => (
                <div className="mgmt-row" key={item.id}>
                  <Link to={`/conversations/${item.id}`}>{item.contactName}</Link>
                  <span className="muted">{phoneText(item)}</span>
                  <span className="muted">{item.topic}</span>
                  <span className="muted">{item.assigneeName || "—"}</span>
                  <span className="muted">{item.activityLabel || "—"}</span>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busyKey === `ret-${item.id}`}
                    onClick={() => run(`ret-${item.id}`, () => api.returnToAi(item.id))}
                  >
                    Передать AI
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {showProblems ? (
        <div className="panel">
          <div className="mgmt-section-head">
            <h3>Проблемы AI</h3>
            <span className="muted">{(data.problems || []).length}</span>
          </div>
          {(data.problems || []).length === 0 ? (
            <p className="empty">AI Manager работает без обнаруженных проблем.</p>
          ) : (
            (data.problems || []).map((item: any) => (
              <div className="mgmt-card compact" key={item.id}>
                <div>
                  <b>{item.title}</b>
                  <div className="muted">{item.detail}</div>
                </div>
                <div className="actions">
                  {item.href ? (
                    <Link className="btn secondary" to={item.href}>
                      {item.href.includes("integrations") ? "Открыть интеграции" : "Открыть диалог"}
                    </Link>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}

      {(data.audit || []).length ? (
        <div className="panel soft">
          <h3>Недавние действия</h3>
          {(data.audit || []).slice(0, 8).map((row: any) => (
            <div className="muted" key={row.id}>
              {row.atLabel} · {row.text}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
