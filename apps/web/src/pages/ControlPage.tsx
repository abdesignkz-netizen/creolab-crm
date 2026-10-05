import { uiText, useUiText, localizeUiOptions, uiMessage , uiDurationLabel } from "../lib/uiText";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { nameWithPhone, phoneText } from "../lib/contactDisplay";
import { api } from "../lib/api";

type Filter =
  | "all"
  | "ai"
  | "human"
  | "intervention"
  | "waiting_client"
  | "approvals"
  | "problems";


export function ControlPage() {
  const uiText = useUiText();
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
      setError(err instanceof Error ? err.message : uiText("Ошибка загрузки"));
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
      if (result?.note) setNote(uiMessage(result.note));
      else if (result?.sellerError) setNote(result.sellerError);
      else if (result?.appliedOnSeller === false) setNote(uiText("Записано в CRM, но на AI это не повлияло."));
      else setNote("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Команда не выполнена"));
    } finally {
      setBusyKey("");
    }
  }

  if (!data && !error) return <div className="state">{uiText("Загрузка…")}</div>;
  if (!data) {
    return (
      <section>
        <p className="error">{error}</p>
        <button type="button" className="btn" onClick={() => void load()}>
          {uiText("Повторить")}</button>
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
          <h2>{uiText("Управление")}</h2>
          <p className="muted">{uiText("Где отвечает AI, а где нужен сотрудник.")}</p>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {note ? <p className="ok">{note}</p> : null}

      <div className="panel management-ai-status">
        <div className="management-ai-status-head">
          <div>
            <b>{uiText("AI-менеджер")}</b>
            <span className={`mgmt-dot ${ai.statusTone === "ok" ? "ok" : "warn"}`} />
            <span>{uiMessage(ai.status)}</span>
          </div>
          <span className="muted">{uiText("Обновлено:")}{" "}{ai.updatedAtLabel || "—"}</span>
        </div>
        <p className="muted">{uiMessage(ai.note)}</p>
        <div className="mgmt-metrics">
          <div>
            <b>{ai.aiControlled ?? 0}</b>
            <span>{uiText("AI ведёт")}</span>
          </div>
          <div>
            <b>{ai.humanControlled ?? 0}</b>
            <span>{uiText("Ведут сотрудники")}</span>
          </div>
          <div>
            <b>{ai.waitingClient ?? 0}</b>
            <span>{uiText("Ждём клиента")}</span>
          </div>
          <div>
            <b>{ai.needsIntervention ?? 0}</b>
            <span>{uiText("Нужно вмешательство")}</span>
          </div>
          <div>
            <b>{ai.pendingApprovals ?? 0}</b>
            <span>{uiText("Ожидают подтверждения")}</span>
          </div>
          <div>
            <b>{ai.problems ?? 0}</b>
            <span>{uiText("Проблемы")}</span>
          </div>
        </div>
        <div className="actions">
          {!ai.paused ? (
            <button type="button" className="btn secondary" onClick={() => setConfirmPause(true)} disabled={busyKey === "pause"}>
              {uiText("Приостановить AI")}</button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={busyKey === "pause"}
              onClick={() => run("pause", () => api.setAiManagerPause(false))}
            >
              {uiText("Возобновить AI")}</button>
          )}
          <button type="button" className="btn secondary" onClick={() => setConfirmClaimAll(true)} disabled={busyKey === "claim-all"}>
            {uiText("Забрать все диалоги у AI")}</button>
          <Link className="btn secondary" to="/integrations">
            {uiText("Открыть интеграции")}</Link>
        </div>
      </div>

      {confirmPause ? (
        <div className="panel soft">
          <b>{uiText("Приостановить AI-менеджера?")}</b>
          <p className="muted">
            {uiText("AI перестанет сам отвечать клиентам. Новые сообщения и заявки по-прежнему будут приходить в CRM.")}</p>
          <div className="actions">
            <button type="button" className="btn secondary" onClick={() => setConfirmPause(false)}>
              {uiText("Отмена")}</button>
            <button
              type="button"
              className="btn"
              disabled={busyKey === "pause"}
              onClick={() => {
                setConfirmPause(false);
                void run("pause", () => api.setAiManagerPause(true));
              }}
            >
              {uiText("Приостановить")}</button>
          </div>
        </div>
      ) : null}

      {confirmClaimAll ? (
        <div className="panel soft">
          <b>{uiText("Забрать все диалоги у AI?")}</b>
          <p className="muted">
            {uiText("AI сейчас ведёт")}{" "}{ai.aiControlled ?? 0} {" "}{uiText("активных диалогов. После подтверждения автоматические ответы в этих диалогах будут остановлены и управление будет передано сотрудникам. Ответственные за сделки не меняются.")}</p>
          <div className="actions">
            <button type="button" className="btn secondary" onClick={() => setConfirmClaimAll(false)}>
              {uiText("Отмена")}</button>
            <button
              type="button"
              className="btn"
              disabled={busyKey === "claim-all"}
              onClick={() => {
                setConfirmClaimAll(false);
                void run("claim-all", () => api.claimAllAiConversations());
              }}
            >
              {uiText("Забрать все")}</button>
          </div>
        </div>
      ) : null}

      <div className="chip-row" style={{ marginBottom: 12 }}>
        {(
          [
            ["all", uiText("Все")],
            ["intervention", uiText("Нужно вмешательство")],
            ["ai", uiText("AI ведёт")],
            ["human", uiText("Человек ведёт")],
            ["waiting_client", uiText("Ждём клиента")],
            ["approvals", uiText("Ожидают подтверждения")],
            ["problems", uiText("Проблемы")],
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
            <h3>{uiText("Требует вмешательства")}</h3>
            <span className="muted">{(data.interventions || []).length}</span>
          </div>
          {(data.interventions || []).length === 0 ? (
            <p className="empty">{uiText("Сейчас AI не требует вмешательства.")}</p>
          ) : (
            (data.interventions || []).map((item: any) => (
              <div className="mgmt-card" key={item.id}>
                <div>
                  <b>
                    {[item.companyName, nameWithPhone(item.contactName, item.phone)].filter(Boolean).join(" · ")}
                  </b>
                  <div className="muted">
                    {[item.topic, item.budgetLabel, uiMessage(item.stageLabel)].filter(Boolean).join(" · ")}
                  </div>
                  <p>
                    <b>{uiText("Почему требуется человек")}</b>
                    <br />
                    {uiMessage(item.reasonLabel)}
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
                    {uiText("Забрать себе")}</button>
                  <Link className="btn secondary" to={`/conversations/${item.id}`}>
                    {uiText("Открыть диалог")}</Link>
                  {item.dealId ? (
                    <Link className="btn secondary" to={`/deals/${item.dealId}`}>
                      {uiText("Открыть сделку")}</Link>
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
            <h3>{uiText("Ждут менеджера")}</h3>
            <span className="muted">{(data.waitingForManager || []).length}</span>
          </div>
          {(data.waitingForManager || []).length === 0 ? (
            <p className="empty">{uiText("Нет клиентов, ожидающих менеджера.")}</p>
          ) : (
            (data.waitingForManager || []).map((item: any) => (
              <div className="mgmt-card compact" key={`wait-${item.id}`}>
                <div>
                  <b>
                    {nameWithPhone(item.contactName, item.phone)}
                    {item.companyName ? ` · ${item.companyName}` : ""}
                  </b>
                  <div className="muted">
                    {uiText("Ждёт")}{" "}{uiDurationLabel(item.waitLabel) || "—"} · {uiMessage(item.reasonLabel)}
                  </div>
                  <div className="muted">{[item.topic, item.budgetLabel, uiMessage(item.stageLabel)].filter(Boolean).join(" · ")}</div>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn"
                    disabled={busyKey === `wait-${item.id}`}
                    onClick={() => run(`wait-${item.id}`, () => api.takeConversation(item.id))}
                  >
                    {uiText("Забрать")}</button>
                  <Link className="btn secondary" to={`/conversations/${item.id}`}>
                    {uiText("Открыть")}</Link>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}

      {showApprovals ? (
        <div className="panel">
          <div className="mgmt-section-head">
            <h3>{uiText("Ожидают подтверждения")}</h3>
            <span className="muted">{(data.pendingApprovals || []).length}</span>
          </div>
          {(data.pendingApprovals || []).length === 0 ? (
            <p className="empty">{uiText("Нет действий AI, ожидающих подтверждения.")}</p>
          ) : (
            (data.pendingApprovals || []).map((item: any) => (
              <div className="mgmt-card compact" key={item.id}>
                <div>
                  <b>
                    {uiMessage(item.actionLabel)}
                    {item.contactName || item.phone ? ` · ${nameWithPhone(item.contactName, item.phone)}` : ""}
                  </b>
                  <div className="muted">
                    {[item.companyName, item.topic, item.channel].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <div className="actions">
                  <Link className="btn" to={item.href || "/tasks"}>
                    {uiText("Проверить")}</Link>
                </div>
              </div>
            ))
          )}
        </div>
      ) : null}

      {showAiList || showWaitingClient ? (
        <div className="panel">
          <div className="mgmt-section-head">
            <h3>{showWaitingClient ? uiText("Ждём клиента") : uiText("AI сейчас ведёт")}</h3>
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
            <p className="empty">{showWaitingClient ? uiText("Никто не ждёт клиента.") : uiText("AI сейчас не ведёт активных диалогов.")}</p>
          ) : (
            <div className="mgmt-table">
              {(showWaitingClient
                ? [...(data.aiConversations || []), ...(data.humanConversations || [])].filter(
                    (i: any) => i.waitingFor === "CLIENT",
                  )
                : data.aiConversations || []
              ).map((item: any) => (
                <Link key={item.id} className="mgmt-row" to={`/conversations/${item.id}`}>
                  <span>{nameWithPhone(item.contactName, item.phone)}</span>
                  <span className="muted">{phoneText(item.phone)}</span>
                  <span className="muted">{item.topic}</span>
                  <span className="muted">{uiMessage(item.stageLabel) || uiMessage(item.modeLabel)}</span>
                  <span className="muted">{uiDurationLabel(item.activityLabel) || "—"}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {showHumanList ? (
        <div className="panel">
          <div className="mgmt-section-head">
            <h3>{uiText("Ведут сотрудники")}</h3>
            <span className="muted">{(data.humanConversations || []).length}</span>
          </div>
          {(data.humanConversations || []).length === 0 ? (
            <p className="empty">{uiText("Нет диалогов у сотрудников.")}</p>
          ) : (
            <div className="mgmt-table">
              {(data.humanConversations || []).map((item: any) => (
                <div className="mgmt-row" key={item.id}>
                  <Link to={`/conversations/${item.id}`}>{nameWithPhone(item.contactName, item.phone)}</Link>
                  <span className="muted">{phoneText(item.phone)}</span>
                  <span className="muted">{item.topic}</span>
                  <span className="muted">{item.assigneeName || "—"}</span>
                  <span className="muted">{uiDurationLabel(item.activityLabel) || "—"}</span>
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={busyKey === `ret-${item.id}`}
                    onClick={() => run(`ret-${item.id}`, () => api.returnToAi(item.id))}
                  >
                    {uiText("Передать AI")}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {showProblems ? (
        <div className="panel">
          <div className="mgmt-section-head">
            <h3>{uiText("Проблемы AI")}</h3>
            <span className="muted">{(data.problems || []).length}</span>
          </div>
          {(data.problems || []).length === 0 ? (
            <p className="empty">{uiText("Сбоев у AI сейчас нет.")}</p>
          ) : (
            (data.problems || []).map((item: any) => (
              <div className="mgmt-card compact" key={item.id}>
                <div>
                  <b>{uiMessage(item.title)}</b>
                  <div className="muted">{item.conversationId ? item.detail : uiMessage(item.detail)}</div>
                </div>
                <div className="actions">
                  {item.href ? (
                    <Link className="btn secondary" to={item.href}>
                      {item.href.includes("integrations") ? uiText("Открыть интеграции") : uiText("Открыть диалог")}
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
          <h3>{uiText("Недавние действия")}</h3>
          {(data.audit || []).slice(0, 8).map((row: any) => (
            <div className="muted" key={row.id}>
              {row.atLabel} · {uiMessage(row.text)}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
