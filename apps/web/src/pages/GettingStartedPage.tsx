import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { systemText, type SetupChannel } from "@creolab/contracts";
import { useLocale } from "../lib/session";
import { setupChannels, setupStepInfo, useSetup } from "../components/SetupAssistant";

export function GettingStartedPage() {
  const { state, error, busy, refresh, update } = useSetup(), locale = useLocale(), navigate = useNavigate();
  const t = (s: string) => systemText(locale, s);
  const [channel, setChannel] = useState<SetupChannel>("whatsapp"), [mode, setMode] = useState<"ai" | "manual">("ai"), [editing, setEditing] = useState(false);
  useEffect(() => { if (state) { setChannel(state.channel || "whatsapp"); setMode(state.started ? state.replyMode : state.available.ai ? "ai" : "manual"); } }, [state?.channel, state?.replyMode, state?.available.ai, state?.started]);
  if (!state) return <section className="setup-page"><h1>{t("Начало работы")}</h1><p role={error ? "alert" : "status"}>{error || t("Проверяем настройки компании…")}</p>{error && <button className="btn" onClick={() => void refresh()} disabled={busy}>{t("Повторить")}</button>}</section>;
  const done = state.steps.filter(s => s.done).length, next = state.steps.find(s => !s.done), choose = !state.started || editing;
  const needsPlan = !state.available[channel] || (mode === "ai" && channel !== "form" && !state.available.ai);
  const editRoute = () => { setChannel(state.channel || "whatsapp"); setMode(state.replyMode); setEditing(true); };
  return <section className="setup-page">
    <header className="setup-header"><div><span className="setup-kicker">BASQAR · {t("ПЕРВЫЙ ЗАПУСК")}</span><h1>{t(state.completed ? "Первое обращение уже в BasQar" : "От первого подключения до первого клиента")}</h1><p>{t("Двигайтесь по шагам. Результат каждого шага проверяем по сохранённым настройкам и сообщениям.")}</p></div>
      {!state.completed && <button type="button" className="btn secondary" disabled={busy} onClick={async () => { if (await update({ deferred: true })) navigate("/today"); }}>{t("Продолжу позже")}</button>}</header>
    <div className="setup-progress"><span>{t("Выполнено шагов")}: {done} / {state.steps.length}</span><progress value={done} max={state.steps.length} aria-label={t("Прогресс настройки")} /></div>
    {error && <div className="setup-error" role="alert">{error}<button className="btn secondary" onClick={() => void refresh()} disabled={busy}>{t("Повторить проверку")}</button></div>}
    {choose && <form className="setup-choices panel" onSubmit={async e => { e.preventDefault(); if (await update({ channel, replyMode: channel === "form" ? "manual" : mode })) setEditing(false); }}>
      <div className="setup-choices-heading"><h2>{t("С чего начнём?")}</h2><p>{t("Выберите один основной канал. Остальные можно подключить позже.")}</p></div>
      <fieldset disabled={busy}><legend>{t("Откуда будут приходить обращения?")}</legend><div className="setup-channel-grid">{setupChannels.map(c => <label key={c.id} className={`setup-option ${channel === c.id ? "selected" : ""}`}>
        <input type="radio" name="channel" value={c.id} checked={channel === c.id} onChange={() => setChannel(c.id)} /><span><b>{t(c.title)}</b><small>{t(c.description)}</small>{!state.available[c.id] && <small>{t("Нужен другой тариф")}</small>}</span>
      </label>)}</div></fieldset>
      {channel !== "form" ? <fieldset disabled={busy}><legend>{t("Кто будет отвечать клиентам?")}</legend><div className="setup-mode-grid">
        <label className={`setup-option ${mode === "ai" ? "selected" : ""}`}><input type="radio" name="mode" checked={mode === "ai"} onChange={() => setMode("ai")} /><span><b>{t("ИИ-менеджер и сотрудники")}</b><small>{t("Обучим ИИ отвечать на типовые вопросы и передавать сложные сотруднику.")}</small></span></label>
        <label className={`setup-option ${mode === "manual" ? "selected" : ""}`}><input type="radio" name="mode" checked={mode === "manual"} onChange={() => setMode("manual")} /><span><b>{t("Пока только сотрудники")}</b><small>{t("Начнём с приёма сообщений. ИИ можно настроить позже.")}</small></span></label>
      </div></fieldset> : <p>{t("Заявки из формы обрабатывает сотрудник. Для переписки с ИИ выберите чат на сайте.")}</p>}
      <div className="setup-choices-footer">
        <p className="muted">{t("Этот выбор меняет только маршрут помощника. ИИ-ответы включаются отдельно в настройках канала.")}</p>
        {needsPlan && <p>{t("Выбранные возможности не входят в текущий тариф.")} <Link to="/billing">{t("Посмотреть тарифы")}</Link></p>}
        <div className="setup-actions"><button className="btn" disabled={busy}>{t(busy ? "Сохраняем…" : "Сохранить и продолжить")}</button>{state.started && <button type="button" className="btn secondary" onClick={() => setEditing(false)}>{t("Отмена")}</button>}</div>
      </div>
    </form>}
    {state.started && !choose && <>
      <div className="setup-route"><span>{t(setupChannels.find(c => c.id === state.channel)?.title || "")} · {t(state.replyMode === "ai" ? "ИИ и сотрудники" : "Ответы сотрудников")}</span><button className="btn secondary" onClick={editRoute}>{t("Изменить маршрут")}</button></div>
      <ol className="setup-step-list">{state.steps.map((s, i) => { const info = setupStepInfo(s.id, state), active = next?.id === s.id;
        const lockedByPlan = (s.id === "channel" && !state.available[state.channel!]) || (["knowledge", "rules"].includes(s.id) && !state.available.ai);
        return <li key={s.id} className={`setup-step ${active ? "current" : ""} ${s.done ? "done" : ""}`} aria-current={active ? "step" : undefined}>
          <span className="setup-step-number" aria-hidden="true">{s.done ? "✓" : i + 1}</span><div><span className="setup-step-status">{t(s.done ? "Готово" : active ? "Сейчас этот шаг" : "Далее")}</span><h2>{t(info.title)}</h2><p>{t(info.text)}</p>
          {s.id === "test" && !s.done && <p className="setup-test-status" role="status">{t(state.evidence.inbound
            ? state.replyMode === "ai" ? "Сообщение получено. Ответ ИИ пока не подтверждён. Проверьте правила, расписание и включение ИИ в канале."
              : "Сообщение получено. Ответьте клиенту из раздела «Диалоги» и дождитесь успешной отправки."
            : "Пока нет нового обращения после начала настройки.")}</p>}
          {s.id === "test" && state.replyMode === "ai" && !s.done && <Link to={setupStepInfo("channel", state).to}>{t("Проверить подключение и ИИ-ответы")}</Link>}
          {lockedByPlan && <p>{t("Для этого шага нужен тариф с выбранной возможностью.")}</p>}
          </div><div className="setup-step-action">{s.id === "path" ? <button className="btn secondary" onClick={editRoute}>{t("Изменить")}</button> : <Link className={`btn ${active ? "" : "secondary"}`} to={lockedByPlan ? "/billing" : info.to}>{t(lockedByPlan ? "Выбрать тариф" : s.done ? "Открыть настройки" : info.action)}</Link>}</div>
        </li>; })}</ol>
      <div className="setup-actions"><button type="button" className="btn secondary" disabled={busy} onClick={() => void refresh()}>{t(busy ? "Проверяем…" : "Проверить готовность")}</button>{state.completed && <button type="button" className="btn" disabled={busy} onClick={async () => { if (await update({ finish: true })) navigate("/today"); }}>{t("Перейти к работе")}</button>}</div>
    </>}
    <section className="setup-later"><h2>{t("Можно настроить позже")}</h2><p>{t("Для первого обращения эти шаги не обязательны.")}</p><div className="setup-later-grid">
      <Link to="/settings?section=members"><b>{t("Команда")}</b><span>{t("Пригласите сотрудников и распределите работу")}</span></Link>
      <Link to="/settings?section=company"><b>{t("Реквизиты")}</b><span>{t("Подготовьте данные для документов")}</span></Link>
      <Link to="/control"><b>BasQar Control</b><span>{t("Получайте сводки и управляйте задачами")}</span></Link>
    </div></section>
  </section>;
}
