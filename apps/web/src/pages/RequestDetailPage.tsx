import { uiText, useUiText, localizeUiOptions, uiMessage, uiFormatLocale } from "../lib/uiText";
import { catalogItemLabel, type TenantService } from "../lib/tenantServices";
import { FormEvent, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { nameWithPhone, phoneText } from "../lib/contactDisplay";
import { formatDurationMinutes, formatWaitSince } from "../lib/duration";
import { api } from "../lib/api";
import { useCapabilities, useSession } from "../lib/session";
import { CALLS_ENABLED } from "../lib/featureFlags";
import { tip } from "../lib/tip";
import { dealOutcomeLabel } from "../lib/labels";

const LOST_REASONS = [
  { value: "expensive", label: "Дорого" },
  { value: "no_reply", label: "Не отвечает" },
  { value: "no_budget", label: "Нет бюджета" },
  { value: "competitor", label: "Выбрал конкурента" },
  { value: "changed_mind", label: "Передумал" },
  { value: "wrong_inquiry", label: "Ошибочное обращение" },
  { value: "spam", label: "Спам" },
  { value: "not_our_service", label: "Нет в нашем ассортименте" },
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
  const uiText = useUiText();
  const caps = useCapabilities();
  const { me } = useSession();
  const aiManagerAllowed = Boolean(me?.billing?.entitlements?.AI_MANAGER);
  const { requestId = "" } = useParams();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showLose, setShowLose] = useState(false);
  const [showDealConfirm, setShowDealConfirm] = useState(false);

  async function load() {
    try {
      setData(await api.inquiry(requestId));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не найдено"));
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
      setError(err instanceof Error ? err.message : uiText("Ошибка"));
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) return <div className="state">{uiText("Загрузка заявки…")}</div>;
  if (!data) {
    return (
      <section>
        <p className="error">{error}</p>
        <Link className="btn secondary" to="/inquiries">
          {uiText("К списку")}</Link>
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
            <Link to="/inquiries">{uiText("Заявки")}</Link>
          </p>
          <h2>{data.subject}</h2>
          <div className="client-meta" style={{ marginTop: 8 }}>
            <span className="badge">{uiMessage(data.statusLabel)}</span>
            {data.needsReply ? (
              <span className="badge warn">
                {uiText("Нужен ответ")}{data.waitingMinutes != null ? ` · ${formatWaitSince(data.waitingMinutes)}` : ""}
              </span>
            ) : null}
            {data.hasDeal ? <span className="badge">{uiText("Сделка создана")}</span> : null}
            {data.test ? <span className="badge warn">{uiText("Тестовая заявка")}</span> : null}
          </div>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}

      <div className="request-hero panel">
        <div>
          <b>{nameWithPhone(data.contactName, data.phone)}</b>
          <div className="muted">{phoneText(data.phone)}</div>
          {data.companyName ? <div>{data.companyName}</div> : null}
          <div className="muted" style={{ marginTop: 8 }}>
            {uiText("Источник:")}{" "}{data.sourceLine}
          </div>
          <div className="muted">{uiText("Создана:")}{" "}{data.receivedLabel}</div>
          <div className="muted">{uiText("Ответственный:")}{" "}{data.assigneeName || uiText("Не назначен")}</div>
        </div>
        <div className="actions">
          {!closed && data.status !== "in_progress" ? (
            <button className="btn" disabled={busy} onClick={() => run(() => api.takeInquiry(data.id))}>
              {uiText("Принять в обработку")}</button>
          ) : null}
          {aiManagerAllowed && data.automation?.canStart && !closed && !caps.manager ? (
            <button
              className="btn"
              disabled={busy}
              {...tip(
                data.automation.status === "awaiting_confirm"
                  ? uiText("AI начнёт писать клиенту по этой заявке")
                  : data.automation.status === "in_progress"
                    ? uiText("Если WhatsApp не ушёл, AI отправит приветствие по этой заявке")
                    : uiText("Передать заявку AI-менеджеру для первого контакта"),
              )}
              onClick={() => run(() => api.startInquiryAi(data.id))}
            >
              {data.automation.status === "awaiting_confirm"
                ? uiText("Начать обработку")
                : data.automation.status === "in_progress"
                  ? uiText("Написать в WhatsApp")
                  : uiText("Передать AI-менеджеру")}
            </button>
          ) : null}
          {data.automation?.canTakeover ? (
            <button
              className="btn secondary"
              disabled={busy}
              {...tip(uiText("Остановить AI и вести заявку вручную"))}
              onClick={() => run(() => api.takeoverInquiryAi(data.id))}
            >
              {uiText("Забрать себе")}</button>
          ) : null}
          {data.automation?.canReturnAi && !caps.manager ? (
            <button
              className="btn secondary"
              disabled={busy}
              {...tip(uiText("Снова отдать заявку AI-менеджеру"))}
              onClick={() => run(() => api.returnInquiryAi(data.id))}
            >
              {uiText("Передать обратно AI")}</button>
          ) : null}
          {data.conversationId ? (
            <Link
              className="btn secondary"
              to={`/conversations/${data.conversationId}`}
              {...tip(uiText("Открыть WhatsApp-диалог по заявке"))}
            >
              {uiText("Написать")}</Link>
          ) : data.contactId ? (
            <Link className="btn secondary" to={`/contacts/${data.contactId}`} {...tip(uiText("Открыть карточку клиента"))}>
              {uiText("Написать")}</Link>
          ) : null}
          {CALLS_ENABLED && canCall ? (
            <a
              className="btn secondary"
              href={`tel:${String(data.phone).replace(/\s+/g, "")}`}
              {...tip(uiText("Позвонить клиенту"))}
            >
              {uiText("Позвонить")}</a>
          ) : null}
          <Link
            className="btn secondary"
            to={`/tasks?inquiryId=${data.id}${data.contactId ? `&contactId=${data.contactId}` : ""}${data.conversationId ? `&conversationId=${data.conversationId}` : ""}${data.dealId ? `&dealId=${data.dealId}` : ""}`}
            {...tip(uiText("Создать задачу с уже привязанной заявкой и клиентом"))}
          >
            {uiText("Создать задачу")}</Link>
          {!data.hasDeal && !closed ? (
            <button
              className="btn"
              disabled={busy}
              {...tip(uiText("Создать сделку по этой заявке"))}
              onClick={() => setShowDealConfirm(true)}
            >
              {uiText("Создать сделку")}</button>
          ) : null}
          {!closed ? (
            <button
              className="btn secondary"
              disabled={busy}
              {...tip(uiText("Отметить заявку потерянной с указанием причины"))}
              onClick={() => setShowLose(true)}
            >
              {uiText("Потеряна…")}</button>
          ) : null}
        </div>
      </div>

      {showDealConfirm ? (
        <div className="panel">
          <b>{uiText("Создать сделку по заявке «")}{data.subject}»?</b>
          <div className="kv">
            <div>
              <dt>{uiText("Клиент")}</dt>
              <dd>{nameWithPhone(data.contactName, data.phone)}</dd>
            </div>
            <div>
              <dt>{uiText("Услуга / товар")}</dt>
              <dd>{data.serviceLabel || "—"}</dd>
            </div>
            <div>
              <dt>{uiText("Сумма")}</dt>
              <dd>{data.budgetLabel || uiText("неизвестна")}</dd>
            </div>
            <div>
              <dt>{uiText("Ответственный")}</dt>
              <dd>{data.assigneeName || uiText("не назначен")}</dd>
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
              {uiText("Создать сделку")}</button>
            <button className="btn secondary" type="button" onClick={() => setShowDealConfirm(false)}>
              {uiText("Отмена")}</button>
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
          <b>{uiText("Закрыть заявку")}</b>
          <label>
            {uiText("Тип")}<select name="classification" defaultValue="lost">
              <option value="lost">{uiText("Потеряна")}</option>
              <option value="invalid">{uiText("Некорректная")}</option>
              <option value="spam">{uiText("Спам")}</option>
              <option value="duplicate">{uiText("Дубликат")}</option>
            </select>
          </label>
          <label>
            {uiText("Причина")}<select name="reason" required defaultValue="no_reply">
              {localizeUiOptions(LOST_REASONS, uiText).map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            {uiText("Комментарий")}<textarea name="comment" rows={2} />
          </label>
          <div className="actions">
            <button className="btn danger" disabled={busy}>
              {uiText("Подтвердить")}</button>
            <button className="btn secondary" type="button" onClick={() => setShowLose(false)}>
              {uiText("Отмена")}</button>
          </div>
        </form>
      ) : null}

      <div className="request-grid">
        <div className="request-main-col">
          {data.automation ? (
            <div className="panel">
              <h3>{uiText("Обработка заявки")}</h3>
              <div className="kv">
                <div>
                  <dt>{uiText("Режим")}</dt>
                  <dd>{uiMessage(data.automation.modeLabel) || data.automation.mode || "—"}</dd>
                </div>
                <div>
                  <dt>{uiText("Исполнитель")}</dt>
                  <dd>
                    {data.automation.status === "none" || data.automation.status === "analyzed"
                      ? uiText("Менеджер")
                      : uiText("AI-менеджер")}
                  </dd>
                </div>
                <div>
                  <dt>{uiText("Статус")}</dt>
                  <dd>
                    <span className="badge">{uiMessage(data.automation.statusLabel)}</span>
                  </dd>
                </div>
                <div>
                  <dt>{uiText("Задача")}</dt>
                  <dd>{data.automation.taskTitle || "—"}</dd>
                </div>
                <div>
                  <dt>{uiText("Следующее действие")}</dt>
                  <dd>{data.automation.taskObjective || data.nextStep || "—"}</dd>
                </div>
              </div>
              {data.automation.reason ? <p className="muted">{uiMessage(data.automation.reason)}</p> : null}
              {data.automation.analysisError ? (
                <div className="actions">
                  <p className="error">{uiText("AI-анализ не выполнен:")}{" "}{data.automation.analysisError}</p>
                  <button className="btn secondary" disabled={busy} onClick={() => run(() => api.retryInquiryAiAnalysis(data.id))}>
                    {uiText("Повторить анализ")}</button>
                </div>
              ) : null}
              {(data.automation.knownFields?.length || data.automation.missingFields?.length) ? (
                <div className="request-gap" style={{ marginTop: 12 }}>
                  <div>
                    <b>{uiText("Уже известно")}</b>
                    <ul>
                      {(data.automation.knownFields || []).map((f: any) => (
                        <li key={f.key}>
                          ✓ {uiMessage(f.label)}
                          {f.value ? `: ${f.value}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <b>{uiText("Нужно выяснить")}</b>
                    <ul>
                      {(data.automation.missingFields || []).map((f: any) => (
                        <li key={f.key}>□ {uiMessage(f.label)}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="panel">
            <h3>{uiText("Кратко")}</h3>
            <p>{data.aiSummary || data.description || uiText("Описание пока не заполнено.")}</p>
          </div>

          <div className="panel">
            <h3>{uiText("Потребность")}</h3>
            <div className="kv">
              <div>
                <dt>{uiText("Что интересует")}</dt>
                <dd>{data.serviceLabel || "—"}</dd>
              </div>
              <div>
                <dt>{uiText("Краткая тема")}</dt>
                <dd>{data.subject || "—"}</dd>
              </div>
              <div>
                <dt>{uiText("Описание задачи")}</dt>
                <dd>{data.description || "—"}</dd>
              </div>
              <div>
                <dt>{uiText("Подкатегория")}</dt>
                <dd>{data.serviceSubcategory || "—"}</dd>
              </div>
              <div>
                <dt>{uiText("Бюджет")}</dt>
                <dd>{data.budgetLabel || uiText("Не определён")}</dd>
              </div>
              <div>
                <dt>{uiText("Срок")}</dt>
                <dd>{data.desiredDeadline || "—"}</dd>
              </div>
              <div>
                <dt>{uiText("Город")}</dt>
                <dd>{data.city || "—"}</dd>
              </div>
            </div>
          </div>

          <div className="panel">
            <h3>{uiText("Источник")}</h3>
            <div className="kv">
              <div>
                <dt>{uiText("Канал обращения")}</dt>
                <dd>{uiMessage(data.channelLabel)}</dd>
              </div>
              <div>
                <dt>{uiText("Источник привлечения")}</dt>
                <dd>{data.attributionLabel || "—"}</dd>
              </div>
              <div>
                <dt>{uiText("Кампания")}</dt>
                <dd>{data.utmCampaign || "—"}</dd>
              </div>
              <div>
                <dt>Landing Page</dt>
                <dd>{data.landingPage || "—"}</dd>
              </div>
            </div>
            {data.utmSource || data.utmCampaign ? (
              <p className="muted" style={{ marginTop: 8 }}>
                {uiText("Метка кампании:")}{" "}{data.utmSource || "—"}
                {data.utmCampaign ? ` · ${data.utmCampaign}` : ""}
              </p>
            ) : null}
          </div>

          <div className="panel">
            <h3>{uiText("История")}</h3>
            <div className="timeline">
              {(data.timeline || []).length === 0 ? <p className="muted">{uiText("Пока пусто")}</p> : null}
              {(data.timeline || []).map((item: any) => (
                <div className="timeline-item" key={item.id}>
                  <div className="muted">{new Date(item.at).toLocaleString(uiFormatLocale())}</div>
                  <b>{item.title}</b>
                  {item.description ? <div className="muted">{item.description}</div> : null}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="request-side-col">
          <div className="panel">
            <h3>{uiText("Сейчас")}</h3>
            <div className="kv">
              <div>
                <dt>{uiText("Статус")}</dt>
                <dd>
                  {!closed ? (
                    <select
                      value={data.status}
                      disabled={busy}
                      onChange={(e) => run(() => api.updateInquiry(data.id, { status: e.target.value }))}
                    >
                      {localizeUiOptions(STATUS_OPTIONS, uiText).map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    uiMessage(data.statusLabel)
                  )}
                </dd>
              </div>
              <div>
                <dt>{uiText("Услуга / товар")}</dt>
                <dd>{!closed ? <select aria-label={uiText("Услуга / товар заявки")} value={data.serviceCategory || ""} disabled={busy} onChange={(event) => run(() => api.updateInquiry(data.id, { serviceCategory: event.target.value || null }))}>
                  <option value="">{uiText("Не определено")}</option>
                  {(data.serviceOptions || []).filter((item: { code: string; active: boolean }) => item.active || item.code === data.serviceCategory).map((item: TenantService) => <option key={item.code} value={item.code}>{catalogItemLabel(item)}{item.active ? "" : uiText(" (архив)")}</option>)}
                </select> : data.serviceLabel}</dd>
              </div>
              <div>
                <dt>{uiText("Ответственный")}</dt>
                <dd>{data.assigneeName || uiText("Не назначен")}</dd>
              </div>
              <div>
                <dt>{uiText("Нужен ответ")}</dt>
                <dd>
                  {data.needsReply
                    ? uiText("Да{p0}", {p0: data.waitingMinutes != null ? ` · ${formatDurationMinutes(data.waitingMinutes)}` : ""})
                    : uiText("Нет")}
                </dd>
              </div>
              <div>
                <dt>{uiText("Следующее действие")}</dt>
                <dd>
                  {data.nextStep || (
                    <>
                      {uiText("Нет следующего действия")}{" "}
                      <Link
                        className="linkish"
                        to={`/tasks?inquiryId=${data.id}${data.contactId ? `&contactId=${data.contactId}` : ""}`}
                      >
                        {uiText("Создать задачу")}</Link>
                    </>
                  )}
                </dd>
              </div>
              <div>
                <dt>{uiText("Сделка")}</dt>
                <dd>{data.hasDeal ? data.dealTitle : uiText("Не создана")}</dd>
              </div>
            </div>
          </div>

          <div className="panel">
            <h3>{uiText("Квалификация")}</h3>
            <div className="qualification-list">
              {(data.qualification || []).map((item: any) => (
                <div key={item.key} className={`qualification-item ${item.ok ? "ok" : "missing"}`}>
                  <span>{item.ok ? "✓" : "—"}</span>
                  <span>{uiMessage(item.label)}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <h3>{uiText("Клиент")}</h3>
            {data.contact ? (
              <>
                <b>{data.contact.name}</b>
                <div className="muted">{data.contact.phone || uiText("Нет телефона")}</div>
                {data.contact.inquiryCount != null ? (
                  <div className="muted">{data.contact.inquiryCount} {" "}{uiText("обращений")}</div>
                ) : null}
                <div className="actions" style={{ marginTop: 10 }}>
                  <Link className="btn secondary" to={`/contacts/${data.contact.id}`}>
                    {uiText("Открыть карточку")}</Link>
                </div>
              </>
            ) : (
              <p className="muted">{uiText("Клиент пока не идентифицирован.")}</p>
            )}
          </div>

          <div className="panel">
            <h3>{uiText("Диалоги")}</h3>
            {data.conversation ? (
              <Link className="row" to={`/conversations/${data.conversation.id}`} style={{ marginTop: 0 }}>
                <div>
                  <b>{data.conversation.channel}</b>
                  <div className="muted">
                    {data.conversation.messageCount != null ? uiText("{p0} сообщений", {p0: data.conversation.messageCount}) : uiText("Открыть переписку")}
                  </div>
                </div>
              </Link>
            ) : (
              <p className="muted">{uiText("Связанных диалогов нет")}</p>
            )}
          </div>

          <div className="panel">
            <h3>{uiText("Сделка")}</h3>
            {data.deal ? (
              <>
                <b>{data.deal.title}</b>
                <div className="muted">{dealOutcomeLabel(data.deal.outcome, data.deal.stage)}</div>
                <div className="actions" style={{ marginTop: 10 }}>
                  <Link className="btn secondary" to="/deals">
                    {uiText("Открыть сделку")}</Link>
                </div>
              </>
            ) : (
              <button className="btn secondary" disabled={busy || closed} onClick={() => setShowDealConfirm(true)}>
                {uiText("+ Создать сделку")}</button>
            )}
          </div>

          <div className="panel">
            <h3>{uiText("Задачи")}</h3>
            {(data.tasks || []).length === 0 ? <p className="muted">{uiText("Задач нет")}</p> : null}
            {(data.tasks || []).map((task: any) => (
              <div className="row" key={task.id} style={{ marginTop: 8 }}>
                <div>
                  <b>{task.title}</b>
                  <div className="muted">
                    {task.status}
                    {task.dueAt ? ` · ${new Date(task.dueAt).toLocaleString(uiFormatLocale())}` : ""}
                  </div>
                </div>
              </div>
            ))}
            <div className="actions" style={{ marginTop: 10 }}>
              <Link
                className="btn secondary"
                to={`/tasks?inquiryId=${data.id}${data.contactId ? `&contactId=${data.contactId}` : ""}${data.conversationId ? `&conversationId=${data.conversationId}` : ""}${data.dealId ? `&dealId=${data.dealId}` : ""}`}
              >
                {uiText("+ Задача")}</Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
