import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { systemText, type SetupChannel, type SetupState, type SetupStep, type SetupUpdate } from "@creolab/contracts";
import { api } from "../lib/api";
import { useLocale, useSession } from "../lib/session";
import "./SetupAssistant.css";

export const setupChannels: Array<{ id: SetupChannel; title: string; description: string }> = [
  { id: "whatsapp", title: "WhatsApp", description: "Клиенты пишут на номер компании" },
  { id: "telegram", title: "Telegram", description: "Обращения в бота компании" },
  { id: "instagram", title: "Instagram", description: "Сообщения в Direct" },
  { id: "website-chat", title: "Чат на сайте", description: "Окно переписки для посетителей сайта" },
  { id: "form", title: "Форма заявки", description: "Контакты и запрос сразу попадают в CRM" },
];
export function setupStepInfo(id: SetupStep, state: SetupState) {
  const channel = state.channel || "whatsapp", name = setupChannels.find(c => c.id === channel)!.title;
  const channelHash = `integration-${channel === "form" ? "website" : channel}`;
  const definitions = {
    path: { title: "Выберите способ работы", text: "Откуда приходят клиенты и кто будет им отвечать? Для начала достаточно одного канала.", to: "/start", action: "Выбрать", target: ".setup-choices" },
    channel: { title: channel === "form" ? "Подключите форму заявки" : channel === "website-chat" ? "Подключите чат на сайте" : `Подключите ${name}`, text: channel === "whatsapp" ? "Добавьте подключение WhatsApp по QR. На телефоне компании откройте WhatsApp → Связанные устройства и отсканируйте код. Дождитесь статуса «Подключён»."
      : channel === "telegram" ? "Создайте бота через @BotFather в Telegram. Вставьте его токен в поле подключения и нажмите «Подключить»."
      : channel === "instagram" ? "Подключите профессиональный аккаунт Instagram и разрешите доступ к сообщениям. Если подключение недоступно, выберите другой канал для первого запуска."
      : channel === "form" ? "Укажите сайт и ответственного, создайте форму и скопируйте код. Установите его на сайт или выберите инструкцию для конструктора."
      : "Включите чат, укажите адрес своего сайта и установите предложенный код на сайт. Факт установки проверим первым сообщением.",
      to: `/integrations?setup=channel#${channelHash}`, action: "Подключить", target: `#${channelHash} > summary` },
    knowledge: { title: "Обучите ИИ вашему бизнесу", text: "Выберите цель: продажи, консультации или поддержка. Ответьте на вопросы об услугах, ценах и условиях. Проверьте ответы в тестовом чате и опубликуйте настройки.", to: "/settings/ai-manager?setup=knowledge", action: "Обучить ИИ", target: ".ai-setup-heading" },
    rules: { title: "Выберите, кому и когда отвечает ИИ", text: "Чтобы ИИ отвечал сам, выберите автоматический режим. Задайте аудиторию, расписание и передачу сотруднику. Сохраните правила. Затем включите ИИ-ответы для выбранного канала в интеграциях.", to: "/settings/ai-automation?setup=rules", action: "Настроить ответы", target: ".ai-manager-overview" },
    test: { title: "Проверьте первое обращение", text: channel === "form" ? "Откройте установленную форму на вашем сайте, заполните её как клиент и отправьте заявку. Проверьте, что контакты и текст появились в разделе «Заявки»."
      : `Напишите в подключённый канал с другого аккаунта${channel === "whatsapp" ? " или телефона" : ""}. ${channel === "website-chat" ? "Для чата сайта откройте свой сайт. " : ""}Проверьте сообщение в «Диалогах»${state.replyMode === "ai" ? " и дождитесь ответа ИИ. Оцените точность и тон ответа" : " и ответьте из BasQar"}.`,
      to: state.evidence.conversationId ? `/conversations/${state.evidence.conversationId}?setup=test`
        : channel === "form" ? "/inquiries?setup=test" : "/conversations?setup=test", action: channel === "form" ? "Открыть заявки" : "Открыть диалоги", target: "[data-onboarding-test]" },
  };
  return definitions[id];
}

type SetupContextValue = { state: SetupState | null; busy: boolean; error: string; refresh: () => Promise<void>; update: (patch: SetupUpdate) => Promise<boolean> };
const SetupContext = createContext<SetupContextValue>({ state: null, busy: false, error: "", refresh: async () => {}, update: async () => false });
export const useSetup = () => useContext(SetupContext);

export function SetupProvider({ children }: { children: ReactNode }) {
  const { me, caps } = useSession(), location = useLocation(), navigate = useNavigate();
  const [state, setState] = useState<SetupState | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const sequence = useRef(0), alive = useRef(true), redirected = useRef(false), saving = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; }; }, []);
  const refresh = useCallback(async () => {
    if (!caps.companyAdmin || saving.current) return;
    const seq = ++sequence.current;
    setBusy(true);
    try { const result = await api.onboarding(); if (alive.current && seq === sequence.current) { setState(result); setError(""); } }
    catch (e) { if (alive.current && seq === sequence.current) setError(e instanceof Error ? e.message : "Не удалось проверить настройку"); }
    finally { if (alive.current && seq === sequence.current) setBusy(false); }
  }, [caps.companyAdmin]);
  const update = useCallback(async (patch: SetupUpdate) => {
    if (saving.current) return false;
    saving.current = true; const seq = ++sequence.current; setBusy(true); setError("");
    try { const result = await api.updateOnboarding(patch); if (alive.current && seq === sequence.current) setState(result); return true; }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "Не удалось сохранить"); return false; }
    finally { saving.current = false; if (alive.current) setBusy(false); }
  }, []);
  useEffect(() => {
    if (location.pathname === "/start" || location.pathname === "/today" || new URLSearchParams(location.search).has("setup")) void refresh();
  }, [location.pathname, location.search, refresh]);
  useEffect(() => {
    const focus = () => { if (location.pathname === "/start" || new URLSearchParams(location.search).has("setup")) void refresh(); };
    window.addEventListener("focus", focus); return () => window.removeEventListener("focus", focus);
  }, [location.pathname, location.search, refresh]);
  useEffect(() => {
    if (!redirected.current && location.pathname === "/today" && state && !state.started && !state.deferred && state.suggested && me?.billing?.onboarding?.status === "not_started") {
      redirected.current = true; navigate("/start", { replace: true });
    }
  }, [state, location.pathname, me, navigate]);
  return <SetupContext.Provider value={{ state, busy, error, refresh, update }}>{children}</SetupContext.Provider>;
}

/** Contextual help stays in the page flow, without blocking clicks or mobile fields. */
export function SetupGuide() {
  const { state, busy, error, refresh } = useSetup(), { caps } = useSession();
  const locale = useLocale(), t = (s: string) => systemText(locale, s);
  const location = useLocation(), navigate = useNavigate();
  const step = new URLSearchParams(location.search).get("setup") as SetupStep | null;
  const highlighted = useRef<Element | null>(null), [located, setLocated] = useState(true);
  useEffect(() => () => { highlighted.current?.classList.remove("setup-highlight"); highlighted.current = null; }, [location.pathname, location.search]);
  if (!caps.companyAdmin || !state?.started || !step || !state.steps.some(s => s.id === step)) return null;
  const info = setupStepInfo(step, state), current = state.steps.find(s => s.id === step)!, next = state.steps.find(s => !s.done);
  const show = () => {
    highlighted.current?.classList.remove("setup-highlight");
    const target = document.querySelector(info.target); setLocated(Boolean(target));
    if (target) { target.classList.add("setup-highlight"); target.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); highlighted.current = target; }
  };
  const close = () => { const params = new URLSearchParams(location.search); params.delete("setup"); navigate({ pathname: location.pathname, search: params.toString(), hash: location.hash }, { replace: true }); };
  return <aside className="setup-guide" aria-label={t("Помощник первого запуска")}>
    <div className="setup-guide-top"><Link to="/start">{t("Начало работы")} · {state.steps.filter(s => s.done).length}/{state.steps.length}</Link><button type="button" onClick={close} className="setup-close" aria-label={t("Закрыть подсказку")}>×</button></div>
    <strong>{t(info.title)}</strong><p>{t(info.text)}</p>
    {current.done && <p className="setup-success" role="status">{t("Шаг проверен. Можно продолжать.")}</p>}
    {!located && <p role="status">{t("Дождитесь загрузки раздела и повторите подсветку.")}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="setup-actions">
      {step !== "test" && <button type="button" className="btn secondary" onClick={show}>{t("Показать где")}</button>}
      <button type="button" className="btn secondary" disabled={busy} onClick={() => void refresh()}>{t(busy ? "Проверяем…" : "Проверить готовность")}</button>
      {step === "rules" && current.done && <Link className="btn secondary" to={setupStepInfo("channel", state).to}>{t("Включить ИИ в канале")}</Link>}
      {current.done && <Link className="btn" to={next ? setupStepInfo(next.id, state).to : "/start"}>{t(next ? "Следующий шаг" : "Завершить настройку")}</Link>}
    </div>
  </aside>;
}
