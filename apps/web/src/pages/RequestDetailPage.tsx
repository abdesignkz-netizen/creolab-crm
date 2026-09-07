import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { CALLS_ENABLED } from "../lib/featureFlags";
import { tip } from "../lib/tip";

const LOST_REASONS = [
  { value: "expensive", label: "Дорого" },
  { value: "no_reply", label: "Не отвечает" },
  { value: "no_budget", label: "Нет бюджета" },
  { value: "competitor", label: "Выбрал конкурента" },
  { value: "changed_mind", label: "Передумал" },
  { value: "wrong_inquiry", label: "Ошибочное обращение" },
  { value: "spam", label: "Спам" },
  { value: "not_our_service", label: "Не наша услуга" },
  { value: "other", label: "Другое" },
];

const STATUS_OPTIONS = [
  { value: "new", label: "Новая" },
  { value: "qualification", label: "Квалификация" },
  { value: "qualified", label: "Квалифицирована" },
  { value: "in_progress", label: "В работе" },
  { value: "waiting_client", label: "Ждём клиента" },
  { value: "proposal", label: "КП отправлено" },
];

export function RequestDetailPage() {
  const { requestId = "" } = useParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showLose, setShowLose] = useState(false);
  const [showDealConfirm, setShowDealConfirm] = useState(false);
  const [showUtm, setShowUtm] = useState(false);

  async function load() {
    try {
      setData(await api.inquiry(requestId));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не найдено");
    }
  }

  useEffect(() => {
    void load();
  }, [requestId]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) return <div className="state">Загрузка заявки…</div>;
  if (!data) {
    return (
      <section>
        <p className="error">{error}</p>
        <Link className="btn secondary" to="/inquiries">
          К списку
        </Link>
      </section>
    );
  }

  const canCall = Boolean(data.phone);
  const closed = ["converted", "lost", "cancelled", "invalid", "spam", "duplicate"].includes(data.status);

  return (
    <section className="request-detail">
      <div className="page-head">
        <div>
          <p className="page-kicker">
            <Link to="/inquiries">Заявки</Link>
          </p>
          <h2>{data.subject}</h2>
          <div className="client-meta" style={{ marginTop: 8 }}>
            <span className="badge">{data.statusLabel}</span>
            {data.needsReply ? (
              <span className="badge warn">
                Нужен ответ{data.waitingMinutes != null ? ` · ${data.waitingMinutes} мин` : ""}
              </span>
            ) : null}
            {data.hasDeal ? <span className="badge">Сделка создана</span> : null}
          </div>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="request-hero panel">
        <div>
          <b>{data.contactName}</b>
          <div className="muted">{data.phone || "Нет телефона"}</div>
          {data.companyName ? <div>{data.companyName}</div> : null}
          <div className="muted" style={{ marginTop: 8 }}>
            Источник: {data.sourceLine}
          </div>
          <div className="muted">Создана: {data.receivedLabel}</div>
          <div className="muted">Ответственный: {data.assigneeName || "Не назначен"}</div>
        </div>
        <div className="actions">
          {!closed && data.status !== "in_progress" ? (
            <button className="btn" disabled={busy} onClick={() => run(() => api.takeInquiry(data.id))}>
              Взять в работу
            </button>
          ) : null}
          {data.automation?.canStart && !closed ? (
            <button
              className="btn"
              disabled={busy}
              {...tip(
                data.automation.status === "awaiting_confirm"
                  ? "AI начнёт писать клиенту по этой заявке"
                  : "Передать заявку AI Manager для квалификации и первого контакта",
              )}
              onClick={() => run(() => api.startInquiryAi(data.id))}
            >
              {data.automation.status === "awaiting_confirm" ? "Начать обработку" : "Передать AI Manager"}
            </button>
          ) : null}
          {data.automation?.canTakeover ? (
            <button
              className="btn secondary"
              disabled={busy}
              {...tip("Остановить AI и вести заявку вручную")}
              onClick={() => run(() => api.takeoverInquiryAi(data.id))}
            >
              Забрать себе
            </button>
          ) : null}
          {data.automation?.canReturnAi ? (
            <button
              className="btn secondary"
              disabled={busy}
              {...tip("Снова отдать заявку AI Manager")}
              onClick={() => run(() => api.returnInquiryAi(data.id))}
            >
              Передать обратно AI
            </button>
          ) : null}
          {data.conversationId ? (
            <Link
              className="btn secondary"
              to={`/conversations/${data.conversationId}`}
              {...tip("Открыть WhatsApp-диалог по заявке")}
            >
              Написать
            </Link>
          ) : data.contactId ? (
            <Link className="btn secondary" to={`/contacts/${data.contactId}`} {...tip("Открыть карточку клиента")}>
              Написать
            </Link>
          ) : null}
          {CALLS_ENABLED && canCall ? (
            <a
              className="btn secondary"
              href={`tel:${String(data.phone).replace(/\s+/g, "")}`}
              {...tip("Позвонить клиенту")}
            >
              Позвонить
            </a>
          ) : null}
          <Link
            className="btn secondary"
            to={`/tasks?inquiryId=${data.id}${data.contactId ? `&contactId=${data.contactId}` : ""}${data.conversationId ? `&conversationId=${data.conversationId}` : ""}${data.dealId ? `&dealId=${data.dealId}` : ""}`}
            {...tip("Создать задачу с уже привязанной заявкой и клиентом")}
          >
            Создать задачу
          </Link>
          {!data.hasDeal && !closed ? (
            <button
              className="btn"
              disabled={busy}
              {...tip("Перевести заявку в сделку воронки")}
              onClick={() => setShowDealConfirm(true)}
            >
              Создать сделку
            </button>
          ) : null}
          {!closed ? (
            <button
              className="btn secondary"
              disabled={busy}
              {...tip("Отметить заявку потерянной с указанием причины")}
              onClick={() => setShowLose(true)}
            >
              Потеряна…
            </button>
          ) : null}
        </div>
      </div>

      {showDealConfirm ? (
        <div className="panel">
          <b>Создать сделку по заявке «{data.subject}»?</b>
          <div className="kv">
            <div>
              <dt>Клиент</dt>
              <dd>{data.contactName}</dd>
            </div>
            <div>
              <dt>Услуга</dt>
              <dd>{data.serviceLabel || "—"}</dd>
            </div>
            <div>
              <dt>Сумма</dt>
              <dd>{data.budgetLabel || "неизвестна"}</dd>
            </div>
            <div>
              <dt>Ответственный</dt>
              <dd>{data.assigneeName || "не назначен"}</dd>
            </div>
          </div>
          <div className="actions">
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.convertInquiry(data.id, { title: data.subject });
                  setShowDealConfirm(false);
                })
              }
            >
              Создать сделку
            </button>
            <button className="btn secondary" type="button" onClick={() => setShowDealConfirm(false)}>
              Отмена
            </button>
          </div>
        </div>
      ) : null}

      {showLose ? (
        <form
          className="panel"
          onSubmit={(event: FormEvent<HTMLFormElement>) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void run(async () => {
              await api.loseInquiry(data.id, {
                reason: form.get("reason"),
                comment: form.get("comment") || undefined,
                classification: form.get("classification") || "lost",
              });
              setShowLose(false);
            });
          }}
        >
          <b>Закрыть заявку</b>
          <label>
            Тип
            <select name="classification" defaultValue="lost">
              <option value="lost">Потеряна</option>
              <option value="invalid">Некорректная</option>
              <option value="spam">Спам</option>
              <option value="duplicate">Дубликат</option>
            </select>
          </label>
          <label>
            Причина
            <select name="reason" required defaultValue="no_reply">
              {LOST_REASONS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Комментарий
            <textarea name="comment" rows={2} />
          </label>
          <div className="actions">
            <button className="btn danger" disabled={busy}>
              Подтвердить
            </button>
            <button className="btn secondary" type="button" onClick={() => setShowLose(false)}>
              Отмена
            </button>
          </div>
        </form>
      ) : null}

      <div className="request-grid">
        <div className="request-main-col">
          {data.automation ? (
            <div className="panel">
              <h3>Обработка заявки</h3>
              <div className="kv">
                <div>
                  <dt>Режим</dt>
                  <dd>{data.automation.modeLabel || data.automation.mode || "—"}</dd>
                </div>
                <div>
                  <dt>Исполнитель</dt>
                  <dd>
                    {data.automation.status === "none" || data.automation.status === "analyzed"
                      ? "Менеджер"
                      : "AI Manager"}
                  </dd>
                </div>
                <div>
                  <dt>Статус</dt>
                  <dd>
                    <span className="badge">{data.automation.statusLabel}</span>
                  </dd>
                </div>
                <div>
                  <dt>Задача</dt>
                  <dd>{data.automation.taskTitle || "—"}</dd>
                </div>
                <div>
                  <dt>Следующее действие</dt>
                  <dd>{data.automation.taskObjective || data.nextStep || "—"}</dd>
                </div>
              </div>
              {data.automation.reason ? <p className="muted">{data.automation.reason}</p> : null}
              {data.automation.analysisError ? (
                <div className="actions">
                  <p className="error">AI-анализ не выполнен: {data.automation.analysisError}</p>
                  <button className="btn secondary" disabled={busy} onClick={() => run(() => api.retryInquiryAiAnalysis(data.id))}>
                    Повторить анализ
                  </button>
                </div>
              ) : null}
              {(data.automation.knownFields?.length || data.automation.missingFields?.length) ? (
                <div className="request-gap" style={{ marginTop: 12 }}>
                  <div>
                    <b>Уже известно</b>
                    <ul>
                      {(data.automation.knownFields || []).map((f: any) => (
                        <li key={f.key}>
                          ✓ {f.label}
                          {f.value ? `: ${f.value}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <b>Нужно выяснить</b>
                    <ul>
                      {(data.automation.missingFields || []).map((f: any) => (
                        <li key={f.key}>□ {f.label}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="panel">
            <h3>Кратко</h3>
            <p>{data.aiSummary || data.description || "Описание пока не заполнено."}</p>
          </div>

          <div className="panel">
            <h3>Потребность</h3>
            <div className="kv">
              <div>
                <dt>Что интересует</dt>
                <dd>{data.serviceLabel || "—"}</dd>
              </div>
              <div>
                <dt>Краткая тема</dt>
                <dd>{data.subject || "—"}</dd>
              </div>
              <div>
                <dt>Описание задачи</dt>
                <dd>{data.description || "—"}</dd>
              </div>
              <div>
                <dt>Подкатегория</dt>
                <dd>{data.serviceSubcategory || "—"}</dd>
              </div>
              <div>
                <dt>Бюджет</dt>
                <dd>{data.budgetLabel || "Не определён"}</dd>
              </div>
              <div>
                <dt>Срок</dt>
                <dd>{data.desiredDeadline || "—"}</dd>
              </div>
              <div>
                <dt>Город</dt>
                <dd>{data.city || "—"}</dd>
              </div>
            </div>
          </div>

          <div className="panel">
            <h3>Источник</h3>
            <div className="kv">
              <div>
                <dt>Канал обращения</dt>
                <dd>{data.channelLabel}</dd>
              </div>
              <div>
                <dt>Источник привлечения</dt>
                <dd>{data.attributionLabel || "—"}</dd>
              </div>
              <div>
                <dt>Кампания</dt>
                <dd>{data.utmCampaign || "—"}</dd>
              </div>
              <div>
                <dt>Landing Page</dt>
                <dd>{data.landingPage || "—"}</dd>
              </div>
            </div>
            <button type="button" className="linkish" onClick={() => setShowUtm((v) => !v)}>
              {showUtm ? "Скрыть UTM" : "Показать UTM"}
            </button>
            {showUtm ? <pre className="code">{JSON.stringify({ utmSource: data.utmSource, utmCampaign: data.utmCampaign }, null, 2)}</pre> : null}
          </div>

          <div className="panel">
            <h3>История</h3>
            <div className="timeline">
              {(data.timeline || []).length === 0 ? <p className="muted">Пока пусто</p> : null}
              {(data.timeline || []).map((item: any) => (
                <div className="timeline-item" key={item.id}>
                  <div className="muted">{new Date(item.at).toLocaleString("ru-RU")}</div>
                  <b>{item.title}</b>
                  {item.description ? <div className="muted">{item.description}</div> : null}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="request-side-col">
          <div className="panel">
            <h3>Сейчас</h3>
            <div className="kv">
              <div>
                <dt>Статус</dt>
                <dd>
                  {!closed ? (
                    <select
                      value={data.status}
                      disabled={busy}
                      onChange={(e) => run(() => api.updateInquiry(data.id, { status: e.target.value }))}
                    >
                      {STATUS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    data.statusLabel
                  )}
                </dd>
              </div>
              <div>
                <dt>Ответственный</dt>
                <dd>{data.assigneeName || "Не назначен"}</dd>
              </div>
              <div>
                <dt>Нужен ответ</dt>
                <dd>
                  {data.needsReply
                    ? `Да${data.waitingMinutes != null ? ` · ${data.waitingMinutes} мин` : ""}`
                    : "Нет"}
                </dd>
              </div>
              <div>
                <dt>Следующее действие</dt>
                <dd>
                  {data.nextStep || (
                    <>
                      Нет следующего действия{" "}
                      <Link
                        className="linkish"
                        to={`/tasks?inquiryId=${data.id}${data.contactId ? `&contactId=${data.contactId}` : ""}`}
                      >
                        Создать задачу
                      </Link>
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>Сделка</dt>
                <dd>{data.hasDeal ? data.dealTitle : "Не создана"}</dd>
              </div>
            </div>
          </div>

          <div className="panel">
            <h3>Квалификация</h3>
            <div className="qualification-list">
              {(data.qualification || []).map((item: any) => (
                <div key={item.key} className={`qualification-item ${item.ok ? "ok" : "missing"}`}>
                  <span>{item.ok ? "✓" : "—"}</span>
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h3>Клиент</h3>
            {data.contact ? (
              <>
                <b>{data.contact.name}</b>
                <div className="muted">{data.contact.phone || "Нет телефона"}</div>
                {data.contact.inquiryCount != null ? (
                  <div className="muted">{data.contact.inquiryCount} обращений</div>
                ) : null}
                <div className="actions" style={{ marginTop: 10 }}>
                  <Link className="btn secondary" to={`/contacts/${data.contact.id}`}>
                    Открыть карточку
                  </Link>
                </div>
              </>
            ) : (
              <p className="muted">Клиент пока не идентифицирован.</p>
            )}
          </div>

          <div className="panel">
            <h3>Диалоги</h3>
            {data.conversation ? (
              <Link className="row" to={`/conversations/${data.conversation.id}`} style={{ marginTop: 0 }}>
                <div>
                  <b>{data.conversation.channel}</b>
                  <div className="muted">
                    {data.conversation.messageCount != null ? `${data.conversation.messageCount} сообщений` : "Открыть переписку"}
                  </div>
                </div>
              </Link>
            ) : (
              <p className="muted">Связанных диалогов нет</p>
            )}
          </div>

          <div className="panel">
            <h3>Сделка</h3>
            {data.deal ? (
              <>
                <b>{data.deal.title}</b>
                <div className="muted">{data.deal.stage || data.deal.outcome}</div>
                <div className="actions" style={{ marginTop: 10 }}>
                  <Link className="btn secondary" to="/deals">
                    Открыть сделку
                  </Link>
                </div>
              </>
            ) : (
              <button className="btn secondary" disabled={busy || closed} onClick={() => setShowDealConfirm(true)}>
                + Создать сделку
              </button>
            )}
          </div>

          <div className="panel">
            <h3>Задачи</h3>
            {(data.tasks || []).length === 0 ? <p className="muted">Задач нет</p> : null}
            {(data.tasks || []).map((task: any) => (
              <div className="row" key={task.id} style={{ marginTop: 8 }}>
                <div>
                  <b>{task.title}</b>
                  <div className="muted">
                    {task.status}
                    {task.dueAt ? ` · ${new Date(task.dueAt).toLocaleString("ru-RU")}` : ""}
                  </div>
                </div>
              </div>
            ))}
            <div className="actions" style={{ marginTop: 10 }}>
              <Link
                className="btn secondary"
                to={`/tasks?inquiryId=${data.id}${data.contactId ? `&contactId=${data.contactId}` : ""}${data.conversationId ? `&conversationId=${data.conversationId}` : ""}${data.dealId ? `&dealId=${data.dealId}` : ""}`}
              >
                + Задача
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
