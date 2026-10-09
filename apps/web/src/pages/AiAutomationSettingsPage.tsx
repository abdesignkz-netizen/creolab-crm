import { WorkspaceSectionNav } from "../components/WorkspaceSectionNav";
import { InlineFeedback } from "../components/InlineFeedback";
import { useUiText, localizeUiOptions } from "../lib/uiText";
import { useLocale, useSession } from "../lib/session";
import { notifySaved } from "../components/SaveNotice";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { NavIcon } from "../components/NavIcon";
import "../ai-manager-settings.css";
import "../ai-manager-setup.css";

type SettingsSection = "replies" | "requests" | "crm" | "prompt" | "knowledge" | "handoff" | "hours";

const SECTION_ITEMS: Array<{ id: SettingsSection; label: string }> = [
  { id: "replies", label: "Кому отвечать" },
  { id: "hours", label: "Когда отвечать" },
  { id: "requests", label: "Писать первым" },
  { id: "handoff", label: "Передача менеджеру" },
];
const EXTRA_SECTIONS: Array<{ id: SettingsSection; label: string }> = [
  { id: "crm", label: "CRM по переписке" }, { id: "prompt", label: "Промпт" }, { id: "knowledge", label: "База знаний" },
];
type Audience = { audience: "all" | "new" | "existing"; since: string | null };

const CRM_OPTIONS = [
  ["enabled", "Автоматически обновлять CRM по переписке"],
  ["inHumanMode", "Продолжать обновления, когда диалог ведёт менеджер"],
  ["updateContact", "Обновлять сводку клиента"],
  ["updateInquiry", "Обновлять заявку и следующий шаг"],
  ["updateDealAmount", "Обновлять явно согласованную сумму сделки"],
  ["updateDealStage", "Продвигать сделку по существующим этапам воронки"],
  ["updateNextAction", "Обновлять следующий шаг сделки"],
  ["detectAgreements", "Сохранять договорённости"],
  ["createTasks", "Создавать задачи по согласованным звонкам и встречам"],
] as const;
type CrmState = Record<(typeof CRM_OPTIONS)[number][0], boolean>;
const DEFAULT_CRM: CrmState = { enabled: false, inHumanMode: true, updateContact: true, updateInquiry: true,
  updateDealAmount: true, updateDealStage: false, updateNextAction: true, detectAgreements: true, createTasks: true };

const HANDOFF_OPTIONS: Array<{ key: string; label: string; hint: string }> = [
  { key: "CLIENT_REQUESTED_HUMAN", label: "Клиент просит связаться с человеком", hint: "Просит менеджера, оператора или «живого человека»." },
  { key: "COMPLAINT", label: "Жалоба или конфликт", hint: "Возмущение, претензия, конфликт." },
  { key: "LOW_CONFIDENCE", label: "AI не может уверенно ответить", hint: "Не хватает данных или ответ получился бы гаданием." },
  { key: "CUSTOM_PRICING", label: "Индивидуальная цена / нестандартные условия", hint: "Скидка, особые условия, цена не из прайса." },
  { key: "CONTRACT", label: "Вопрос по договору", hint: "Договор, контракт, оферта." },
  { key: "PAYMENT", label: "Вопрос по оплате", hint: "Счёт, платёж, реквизиты." },
  { key: "OTHER", label: "Нестандартный запрос", hint: "Сложный или технический вопрос вне обычного сценария." },
];

const WEEK_DAYS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Понедельник" },
  { value: 2, label: "Вторник" },
  { value: 3, label: "Среда" },
  { value: 4, label: "Четверг" },
  { value: 5, label: "Пятница" },
  { value: 6, label: "Суббота" },
  { value: 0, label: "Воскресенье" },
];

const TIMEZONES = ["Asia/Almaty", "Asia/Aqtobe", "Asia/Qyzylorda", "Asia/Aqtau", "Asia/Oral", "Europe/Moscow", "UTC"];

type DayHours = { enabled: boolean; start: string; end: string };
type HandoffState = { triggers: Record<string, boolean>; afterMode: "human" | "assist" };
type FollowUpState = {
  enabled: boolean;
  delaysMinutes: number[];
  maxAttempts: number;
  skipIfRefused: boolean;
  skipIfHandedToHuman: boolean;
  skipIfDealClosed: boolean;
  skipIfClientReplied: boolean;
  respectWorkingHours: boolean;
};
type ConversationHoursState = {
  mode: "always" | "schedule";
  days: Record<number, DayHours>;
  offHoursBehavior: "continue" | "accept_no_process" | "no_reply";
};

const DEFAULT_HANDOFF: HandoffState = {
  triggers: {
    CLIENT_REQUESTED_HUMAN: false,
    COMPLAINT: false,
    LOW_CONFIDENCE: false,
    CUSTOM_PRICING: false,
    CONTRACT: false,
    PAYMENT: false,
    OTHER: false,
  },
  afterMode: "human",
};
const DEFAULT_FOLLOWUP: FollowUpState = {
  enabled: false,
  delaysMinutes: [120, 1440, 4320],
  maxAttempts: 3,
  skipIfRefused: true,
  skipIfHandedToHuman: true,
  skipIfDealClosed: true,
  skipIfClientReplied: true,
  respectWorkingHours: true,
};
const DEFAULT_HOURS: ConversationHoursState = {
  mode: "always",
  offHoursBehavior: "accept_no_process",
  days: {
    1: { enabled: true, start: "09:00", end: "20:00" },
    2: { enabled: true, start: "09:00", end: "20:00" },
    3: { enabled: true, start: "09:00", end: "20:00" },
    4: { enabled: true, start: "09:00", end: "20:00" },
    5: { enabled: true, start: "09:00", end: "20:00" },
    6: { enabled: true, start: "10:00", end: "18:00" },
    0: { enabled: false, start: "10:00", end: "18:00" },
  },
};

function delayUi(minutes: number) {
  if (minutes >= 1440 && minutes % 1440 === 0) return { value: minutes / 1440, unit: "days" as const };
  return { value: Math.max(1, Math.round(minutes / 60)), unit: "hours" as const };
}

function delayMinutes(value: number, unit: "hours" | "days") {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return unit === "days" ? 1440 : 60;
  return unit === "days" ? Math.min(30, Math.round(n)) * 1440 : Math.min(72, Math.round(n)) * 60;
}

export function AiAutomationSettingsPage() {
  const uiText = useUiText();
  const { me } = useSession();
  const locale = useLocale();
  const text = (ru: string, kk: string, en: string) => locale === "kk" ? kk : locale === "en" ? en : ru;
  const aiManagerAllowed = Boolean(me?.billing?.entitlements?.AI_MANAGER);
  const aiManagerTrial = aiManagerAllowed && me?.billing?.planCode === "BASQAR_FREE";
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState<SettingsSection>("replies");
  const [replyAudience, setReplyAudience] = useState<Audience>({ audience: "all", since: null });
  const [proactive, setProactive] = useState(true);
  const [savedSnapshot, setSavedSnapshot] = useState("");
  const [crm, setCrm] = useState<CrmState>(DEFAULT_CRM);
  const [mode, setMode] = useState("CONFIRM");
  const [processRepeat, setProcessRepeat] = useState(true);
  const [sla, setSla] = useState(15);
  const [timezone, setTimezone] = useState("Asia/Almaty");
  const [handoff, setHandoff] = useState<HandoffState>(DEFAULT_HANDOFF);
  const [followUp, setFollowUp] = useState<FollowUpState>(DEFAULT_FOLLOWUP);
  const [conversationHours, setConversationHours] = useState<ConversationHoursState>(DEFAULT_HOURS);

  async function load() {
    try {
      const next = (await api.aiAutomationSettings()) as {
        replyAudience?: Audience;
        crm?: CrmState;
        defaultMode: string;
        processRepeatRequests: boolean;
        firstContactSlaMinutes: number;
        scheduleMode: string;
        workingHours?: { days: number[]; start: string; end: string };
        customSchedule?: { days: number[]; start: string; end: string };
        timezone?: string;
        modes?: Array<{ mode: string; label: string }>;
        sourceModes?: Record<string, string>;
        serviceModes?: Record<string, string>;
        allowProactiveOutbound?: boolean;
        handoff?: HandoffState;
        followUp?: FollowUpState;
        conversationHours?: ConversationHoursState;
      };
      setReplyAudience(next.replyAudience || { audience: "all", since: null });
      setProactive(next.allowProactiveOutbound !== false);
      setCrm({ ...DEFAULT_CRM, ...next.crm });
      setData(next);
      setMode(next.defaultMode);
      setProcessRepeat(Boolean(next.processRepeatRequests));
      setSla(Number(next.firstContactSlaMinutes) || 15);
      setTimezone(next.timezone || "Asia/Almaty");
      if (next.handoff) {
        setHandoff({
          afterMode: next.handoff.afterMode === "assist" ? "assist" : "human",
          triggers: { ...DEFAULT_HANDOFF.triggers, ...(next.handoff.triggers || {}) },
        });
      }
      if (next.followUp) {
        setFollowUp({
          ...DEFAULT_FOLLOWUP,
          ...next.followUp,
          delaysMinutes: Array.isArray(next.followUp.delaysMinutes) && next.followUp.delaysMinutes.length
            ? next.followUp.delaysMinutes
            : DEFAULT_FOLLOWUP.delaysMinutes,
        });
      }
      if (next.conversationHours) {
        const days = { ...DEFAULT_HOURS.days };
        for (const [key, value] of Object.entries(next.conversationHours.days || {})) {
          days[Number(key)] = value as DayHours;
        }
        setConversationHours({
          mode: next.conversationHours.mode === "schedule" ? "schedule" : "always",
          offHoursBehavior: next.conversationHours.offHoursBehavior || "accept_no_process",
          days,
        });
      }
      // Surface the effective legacy schedule in the single schedule editor.
      if (next.conversationHours?.mode !== "schedule" && next.scheduleMode !== "always") {
        const legacy = next.scheduleMode === "custom" ? next.customSchedule : next.workingHours;
        if (legacy) setConversationHours({ mode: "schedule", offHoursBehavior: "accept_no_process",
          days: Object.fromEntries(WEEK_DAYS.map(day => [day.value, { enabled: legacy.days.includes(day.value), start: legacy.start, end: legacy.end }])) });
      }
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось загрузить"));
    }
  }

  useEffect(() => {
    if (aiManagerAllowed) void load();
  }, [aiManagerAllowed]);

  const draftSnapshot = JSON.stringify({ crm, mode, processRepeat, sla, timezone, handoff, followUp, conversationHours, replyAudience, proactive });
  useEffect(() => { if (data) setSavedSnapshot(draftSnapshot); }, [data]);
  const dirty = Boolean(savedSnapshot && savedSnapshot !== draftSnapshot);
  useEffect(() => { if (dirty) setHint(""); }, [dirty]);
  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventLoss);
    return () => window.removeEventListener("beforeunload", preventLoss);
  }, [dirty]);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    setHint("");
    try {
      const result = (await api.updateAiAutomationSettings({
        crm,
        replyAudience,
        allowProactiveOutbound: proactive,
        defaultMode: mode,
        processRepeatRequests: processRepeat,
        firstContactSlaMinutes: sla,
        scheduleMode: "always",
        timezone,
        handoff,
        followUp,
        conversationHours,
      })) as { message?: string };
      setHint(result.message || uiText("Сохранено"));
      notifySaved(uiText("Настройки AI сохранены"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Ошибка сохранения"));
    } finally {
      setBusy(false);
    }
  }

  if (!aiManagerAllowed) return <section className="panel"><h2>{uiText("ИИ-менеджер")}</h2><p>{uiText("ИИ-менеджер не входит в ваш тариф. Пробный режим доступен в Free; работа с клиентами — в Business и Pro.")}</p><Link to="/billing">{uiText("Посмотреть тарифы")}</Link></section>;
  if (!data && !error) return <div className="state">{uiText("Загрузка настроек…")}</div>;
  if (!data) return <section><InlineFeedback kind="error">{error}</InlineFeedback><button type="button" className="btn" onClick={() => void load()}>{uiText("Повторить")}</button></section>;

  return (
    <section className="ai-settings-workspace">
      {aiManagerTrial ? <p className="banner">{uiText("Пробный режим ИИ-менеджера для ознакомления с консультациями клиентов и обработкой заявок. В Free доступно 100 AI-кредитов один раз, общих для всех AI-функций.")}</p> : null}
      <div className="page-head">
        <div>
          <p className="page-kicker">
            <Link to="/settings">{uiText("Настройки")}</Link> {" "}{uiText("· AI-менеджер")}</p>
          <h2>{uiText("AI-менеджер")}</h2>
          <p className="muted">
            {text("Выберите, кому и когда отвечает ИИ. Отдельно настройте первый контакт и передачу сотруднику.", "ЖИ кімге және қашан жауап беретінін таңдаңыз. Алғашқы байланысты және қызметкерге беруді бөлек баптаңыз.", "Choose who AI replies to and when. Set first contact and staff handoff separately.")}</p>
        </div>
      </div>

      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      {hint ? <InlineFeedback kind="success" className="ok">{hint}</InlineFeedback> : null}
      {data.runtimePaused && <p className="banner">{text("ИИ приостановлен в управлении компанией. Эти правила начнут действовать после снятия паузы.", "Компанияны басқаруда ЖИ кідіртілген. Ережелер кідіріс алынғаннан кейін іске қосылады.", "AI is paused in company management. These rules apply after the pause is lifted.")}</p>}

      <div className="ai-setup-entry"><div><h3>{text("Чему обучить ИИ?", "ЖИ-ге нені үйрету керек?", "What should your AI know?")}</h3><p>{text("Функции, услуги, цены, сценарии и база знаний — настройте самостоятельно через вопросы.", "Міндеттерді, қызметтерді, бағаны, сценарийді және білімді сұрақтар арқылы баптаңыз.", "Set functions, services, pricing, conversation flow and knowledge through guided questions.")}</p></div><Link className="btn secondary" to="/settings/ai-manager">{text("Открыть мастер", "Шеберді ашу", "Open setup wizard")}</Link></div>
      <div className="ai-manager-overview">
        <div className="ai-manager-heading"><span className="ai-manager-mark"><NavIcon to="/admin/ai-managers" /></span><div><b>{text("Правила работы", "Жұмыс ережелері", "Reply rules")}</b><p>{dirty ? text("Предпросмотр · есть несохранённые изменения", "Алдын ала көрініс · сақталмаған өзгерістер бар", "Preview · unsaved changes") : text("Текущие настройки", "Ағымдағы баптаулар", "Current settings")}</p></div><span className={`badge ${mode === "AUTO" ? "ok" : ""}`}>{data.runtimePaused ? text("На паузе", "Кідірісте", "Paused") : mode === "AUTO" ? text("Автоматически", "Автоматты түрде", "Automatic") : mode === "MANUAL" ? text("Выключен", "Өшірулі", "Off") : text("С участием сотрудника", "Қызметкердің қатысуымен", "Staff assisted")}</span></div>
        <div className="ai-manager-facts">
          <button type="button" onClick={() => setSection("replies")}><small>{text("Кому", "Кімге", "Who")}</small><b>{replyAudience.audience === "all" ? text("Всем клиентам", "Барлық клиентке", "All clients") : replyAudience.audience === "new" ? text("Только новым", "Тек жаңа клиенттерге", "New clients only") : text("Текущей базе", "Қазіргі клиенттерге", "Existing clients only")}</b></button>
          <button type="button" onClick={() => setSection("hours")}><small>{text("Когда", "Қашан", "When")}</small><b>{conversationHours.mode === "always" || conversationHours.mode === "schedule" && conversationHours.offHoursBehavior === "continue" ? uiText("Круглосуточно") : uiText("По расписанию")}</b></button>
          <button type="button" onClick={() => setSection("requests")}><small>{text("Первый контакт", "Алғашқы байланыс", "First contact")}</small><b>{proactive && mode === "AUTO" ? text("По входящим заявкам", "Кіріс өтінімдер бойынша", "For incoming requests") : text("Без сообщений первым", "Бірінші болып жазбайды", "No first messages")}</b></button>
        </div>
      </div>
      <WorkspaceSectionNav label={uiText("Настройки AI")} value={section} options={[...SECTION_ITEMS, ...(EXTRA_SECTIONS.some(item => item.id === section) ? EXTRA_SECTIONS : [])].map(item => ({ ...item, label: item.id === "replies" ? text("Кому отвечать", "Кімге жауап беру", "Who to reply to") : item.id === "hours" ? text("Когда отвечать", "Қашан жауап беру", "When to reply") : item.id === "requests" ? text("Писать первым", "Бірінші болып жазу", "First contact") : uiText(item.label) }))} onChange={setSection} />
      <details className="ai-manager-extra"><summary>{uiText("Дополнительные настройки")}</summary><div className="actions">{EXTRA_SECTIONS.map(item => <button key={item.id} className={`btn ${section === item.id ? "" : "secondary"}`} onClick={() => setSection(item.id)}>{uiText(item.label)}</button>)}</div></details>

      <fieldset className="ai-manager-editor" disabled={busy}>
      {section === "replies" ? <>
      <div className="panel">
        <b>{text("Как работает ИИ", "ЖИ қалай жұмыс істейді", "How AI works")}</b>
        <div className="ai-mode-grid" role="group" aria-label={text("Как работает ИИ", "ЖИ қалай жұмыс істейді", "How AI works")}>
          {([...data.modes].sort((a: { mode: string }, b: { mode: string }) => ["AUTO", "CONFIRM", "ASSIST", "MANUAL"].indexOf(a.mode) - ["AUTO", "CONFIRM", "ASSIST", "MANUAL"].indexOf(b.mode))).map((item: { mode: string; label: string }) => (
            <label key={item.mode} className={`ai-mode-card${mode === item.mode ? " is-selected" : ""}`}>
              <input
                type="radio"
                name="aiMode"
                checked={mode === item.mode}
                onChange={() => setMode(item.mode)}
              />
              <span>
                <b>{item.mode === "AUTO" ? text("Отвечает автоматически", "Автоматты жауап береді", "Automatic replies") : item.mode === "CONFIRM" ? text("Включаю в нужном диалоге", "Қажетті диалогта қосамын", "I enable AI per conversation") : item.mode === "MANUAL" ? text("Выключен", "Өшірулі", "Off") : text("Только помогает сотруднику", "Қызметкерге ғана көмектеседі", "Staff assistance only")}</b>
                <span className="ai-mode-help">{item.mode === "AUTO" ? text("Берёт новые диалоги по правилам ниже. Диалоги сотрудников остаются у сотрудников.", "Төмендегі ережелерге сай жаңа диалогтарды алады. Қызметкер диалогтары қызметкерде қалады.", "Starts new conversations under these rules. Staff conversations stay with staff.") : item.mode === "CONFIRM" ? text("Для ответа нажмите «Вернуть AI» в диалоге или запустите подготовленную задачу.", "Жауап алу үшін диалогта «ЖИ-ге қайтару» түймесін басыңыз немесе дайын тапсырманы іске қосыңыз.", "Select Return to AI in a conversation or start a prepared task.") : item.mode === "MANUAL" ? text("Не анализирует обращения и не пишет клиентам.", "Өтініштерді талдамайды және клиенттерге жазбайды.", "Does not analyze requests or message clients.") : text("Анализирует обращения для сотрудника. Сам клиентам не отвечает.", "Қызметкер үшін өтініштерді талдайды. Клиенттерге өзі жауап бермейді.", "Analyzes requests for staff without replying to clients.")}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
      <div className="panel ai-audience-panel"><h3>{text("Кому можно отвечать", "Кімге жауап беруге болады", "Who can receive replies")}</h3>
        <div className="ai-audience-grid">{([
          ["all", text("Всем клиентам", "Барлық клиентке", "All clients"), text("Новым и тем, кто уже есть в CRM.", "Жаңа және CRM-дегі клиенттерге.", "New clients and clients already in the CRM.")],
          ["new", text("Только новым клиентам", "Тек жаңа клиенттерге", "New clients only"), text("Клиентам, появившимся в CRM после включения этого правила.", "Ереже қосылғаннан кейін CRM-де пайда болған клиенттерге.", "Clients added to the CRM after this rule was enabled.")],
          ["existing", text("Только текущей базе", "Тек қазіргі клиенттерге", "Existing clients only"), text("Клиентам, которые были в CRM до включения правила.", "Ереже қосылғанға дейін CRM-де болған клиенттерге.", "Clients already in the CRM when the rule was enabled.")],
        ] as const).map(([value, title, description]) => <label className={`ai-mode-card${replyAudience.audience === value ? " is-selected" : ""}`} key={value}><input type="radio" name="replyAudience" value={value} checked={replyAudience.audience === value} onChange={() => setReplyAudience(previous => ({ ...previous, audience: value }))}/><span><b>{title}</b><span className="ai-mode-help">{description}</span></span></label>)}</div>
        {replyAudience.audience !== "all" && <p className="muted">{replyAudience.since ? <>{text("Граница новой и текущей базы:", "Жаңа және қазіргі клиенттер шекарасы:", "New/existing client boundary:")} {new Date(replyAudience.since).toLocaleString(locale === "kk" ? "kk-KZ" : locale === "en" ? "en-GB" : "ru-RU", { timeZone: timezone })} · {timezone}</> : text("Отсчёт начнётся после сохранения. Последующие изменения расписания не сдвигают эту дату.", "Есептеу сақтағаннан кейін басталады. Кестені өзгерту бұл күнді өзгертпейді.", "The boundary is set when you save. Later schedule changes do not move it.")}</p>}
        <p className="ai-manager-note">{text("ИИ отвечает только в подключённых каналах с включёнными ИИ-ответами. Передача диалога человеку и запрет контакта имеют приоритет. Выбор «Всем» не запускает рассылку и не забирает диалоги у сотрудников.", "ЖИ тек қосылған және ЖИ жауаптары қосулы арналарда жауап береді. Адамға берілген диалог пен байланысуға тыйым басым. «Барлығына» тарату бастамайды және қызметкерлерден диалогтарды алмайды.", "AI replies only in connected channels with AI replies enabled. Staff handoff and contact restrictions take priority. All clients does not start a campaign or take conversations from staff.")}</p>
      </div>
      <div className="panel"><div className="ai-manager-heading"><div><h3>{text("Где работает ИИ", "ЖИ қайда жұмыс істейді", "Connected channels")}</h3><p className="muted">{text("ИИ-ответы включаются отдельно для каждого номера WhatsApp.", "ЖИ жауаптары әр WhatsApp нөміріне бөлек қосылады.", "AI replies are enabled separately for each WhatsApp number.")}</p></div><Link className="btn secondary" to="/integrations">{uiText("Интеграции")}</Link></div>
        {data.channels?.length ? data.channels.map((channel: any) => <div className="ai-channel-row" key={channel.id}><b>{channel.name}</b><span className={`badge ${channel.connected && channel.enabled ? "ok" : ""}`}>{!channel.connected ? text("Не подключён", "Қосылмаған", "Disconnected") : channel.enabled ? text("ИИ-ответы включены", "ЖИ жауаптары қосулы", "AI replies enabled") : text("ИИ-ответы выключены", "ЖИ жауаптары өшірулі", "AI replies disabled")}</span></div>) : <p className="muted">{text("Подключите WhatsApp, чтобы ИИ мог отвечать клиентам.", "ЖИ клиенттерге жауап беруі үшін WhatsApp қосыңыз.", "Connect WhatsApp to enable client replies.")}</p>}
        {data.legacyChannels?.length > 0 && <div className="ai-manager-note"><b>{text("Отдельный AI-продавец", "Жеке ЖИ-сатушы", "Standalone AI seller")}</b><p>{data.legacyChannels.map((channel: { name: string }) => channel.name).join(", ")}</p><p>{text("В этом подключении выбор аудитории может потребовать обновления у администратора. Если определить клиента не удастся, ИИ пропустит его сообщение. WhatsApp через QR и Cloud API поддерживают правила сразу.", "Бұл қосылымда аудиторияны таңдау үшін әкімші жаңартуы қажет болуы мүмкін. Клиент анықталмаса, ЖИ жауап бермейді. QR және Cloud API бұл ережелерді бірден қолдайды.", "Audience filtering may require an administrator to update this connection. If the client cannot be identified, AI skips the reply. WhatsApp QR and Cloud API support these rules directly.")}</p></div>}
      </div>
      </> : null}
      {section === "requests" ? (
        <>
      <p className="ai-manager-note">{text("Первый контакт по заявке доступен через отдельную интеграцию AI-продавца. Для WhatsApp через QR и Cloud API сейчас доступны ответы на входящие сообщения.", "Өтінім бойынша алғашқы байланыс жеке ЖИ-сатушы интеграциясында қолжетімді. QR және Cloud API арқылы WhatsApp-та кіріс хабарламаларына жауап беру қолжетімді.", "First contact from requests requires the standalone AI seller integration. WhatsApp QR and Cloud API currently support inbound replies.")}</p>
      <div className="panel"><h3>{text("Писать первым по заявке", "Өтінім бойынша бірінші жазу", "Start contact from a request")}</h3><label className="check-row"><input type="checkbox" checked={proactive} onChange={event => setProactive(event.target.checked)}/><span>{text("Разрешить первое сообщение по входящей заявке", "Кіріс өтінім бойынша алғашқы хабарламаға рұқсат беру", "Allow the first message for an incoming request")}</span></label><p className="muted">{text("Например, клиент оставил номер на сайте. В автоматическом режиме ИИ начнёт общение. Если выключить, ответы на входящие сообщения продолжат работать. Массовая рассылка по базе не запускается.", "Мысалы, клиент сайтта нөмірін қалдырды. Автоматты режимде ЖИ сөйлесуді бастайды. Өшірсеңіз, кіріс хабарламаларға жауап жалғасады. Клиенттерге жаппай тарату басталмайды.", "For example, a client leaves their number on your website. In automatic mode, AI starts the conversation. Switching this off keeps inbound replies working and never starts a campaign.")}</p></div>


      <div className="panel">
        <label className="check-row">
          <input type="checkbox" checked={processRepeat} onChange={(e) => setProcessRepeat(e.target.checked)} />
          <span>{uiText("Автоматически обрабатывать повторные заявки")}</span>
        </label>
        <label>
          {uiText("Первичный контакт")}<select value={sla} onChange={(e) => setSla(Number(e.target.value))}>
            {[5, 10, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                {uiText("до")}{" "}{m} {" "}{uiText("минут")}</option>
            ))}
          </select>
        </label>
        <p className="muted">{text("Повторная заявка — новое обращение уже знакомого клиента. Правило аудитории из раздела «Кому отвечать» продолжает действовать. Время ответа задаётся в разделе «Когда отвечать».", "Қайталанған өтінім — бұрыннан таныс клиенттің жаңа өтініші. Аудитория ережесі сақталады. Жауап уақыты «Қашан жауап беру» бөлімінде орнатылады.", "A repeat request is a new request from a known client. Audience restrictions still apply. Set reply times in When to reply.")}</p>
      </div>
        </>
      ) : null}

      {section === "crm" ? <div className="panel">
        <b>{uiText("CRM по переписке")}</b>
        <p className="muted">{uiText("При включённой настройке AI сохраняет подтверждённые факты в режимах AUTO и «После подтверждения». В HUMAN обновления могут продолжаться без ответов клиенту. ASSIST и пауза оставляют только предложения; ручной режим отключает автообновления.")}</p>
        <div className="stack">
          {localizeUiOptions(CRM_OPTIONS, uiText).map(([key, label]) => <label className="check-row" key={key}>
            <input type="checkbox" checked={crm[key]} disabled={key !== "enabled" && !crm.enabled}
              onChange={event => setCrm(current => ({ ...current, [key]: event.target.checked }))} />
            <span>{label}</span>
          </label>)}
        </div>
        <p className="muted">{uiText("AI не подтверждает оплату, не закрывает сделки и не отправляет документы по этим настройкам. Неоднозначные суммы и время требуют уточнения. Сумма по позициям сделки сохраняется.")}</p>
      </div> : null}

      {section === "prompt" || section === "knowledge" ? <div className="ai-setup-entry"><div><h3>{text("Инструкции и знания вашей компании", "Компания нұсқаулығы мен білімі", "Your company instructions and knowledge")}</h3><p>{text("Выберите функции ИИ и ответьте на вопросы. Мастер соберёт промпт и базу знаний, которые можно проверить перед публикацией.", "ЖИ міндеттерін таңдап, сұрақтарға жауап беріңіз. Шебер жариялау алдында тексерілетін промпт пен білім базасын құрастырады.", "Choose AI functions and answer guided questions. Review the generated instructions and knowledge before publishing.")}</p></div><Link className="btn" to="/settings/ai-manager">{text("Настроить ИИ", "ЖИ баптау", "Set up AI")}</Link></div> : null}

      {section === "handoff" ? (
        <div className="panel">
          <b>{uiText("Передача менеджеру")}</b>
          <p className="muted">{uiText("Когда AI должен перестать вести диалог сам и отдать его сотруднику.")}</p>
          <div className="stack" style={{ marginTop: 12, gap: 10 }}>
            {localizeUiOptions(HANDOFF_OPTIONS, uiText).map((item) => (
              <label key={item.key} className="check-row">
                <input
                  type="checkbox"
                  checked={Boolean(handoff.triggers[item.key])}
                  onChange={(event) =>
                    setHandoff((prev) => ({
                      ...prev,
                      triggers: { ...prev.triggers, [item.key]: event.target.checked },
                    }))
                  }
                />
                <span>
                  {item.label}
                  <div className="muted">{item.hint}</div>
                </span>
              </label>
            ))}
          </div>
          <div className="stack" style={{ marginTop: 16, gap: 10 }}>
            <b>{uiText("После передачи")}</b>
            <label className="radio-row">
              <input
                type="radio"
                name="handoffAfter"
                checked={handoff.afterMode === "human"}
                onChange={() => setHandoff((prev) => ({ ...prev, afterMode: "human" }))}
              />
              <span>
                <b>{uiText("AI прекращает отвечать")}</b>
                <div className="muted">{uiText("Диалог забирает сотрудник. Бот клиенту больше не пишет.")}</div>
              </span>
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="handoffAfter"
                checked={handoff.afterMode === "assist"}
                onChange={() => setHandoff((prev) => ({ ...prev, afterMode: "assist" }))}
              />
              <span>
                <b>{uiText("AI подсказывает менеджеру")}</b>
                <div className="muted">{uiText("Клиенту не пишет, но оставляет подсказку сотруднику.")}</div>
              </span>
            </label>
          </div>
        </div>
      ) : null}

      {section === "requests" ? (
        <div className="panel">
          <b>{uiText("Повторный контакт")}</b>
          <p className="ai-manager-note">{text("Автоматические напоминания доступны через отдельную интеграцию AI-продавца. Для WhatsApp через QR и Cloud API эта функция пока не поддерживается.", "Автоматты еске салулар жеке ЖИ-сатушы интеграциясында қолжетімді. QR және Cloud API арқылы WhatsApp-та бұл функция әзірге жоқ.", "Automatic follow-ups require the standalone AI seller integration. WhatsApp QR and Cloud API do not support them yet.")}</p>
          <p className="muted">{uiText("AI может повторно написать клиенту, если клиент перестал отвечать. Текст берётся из последнего разговора, не из шаблона.")}</p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={followUp.enabled}
              onChange={(event) => setFollowUp((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <span>{uiText("Автоматический повторный контакт")}</span>
          </label>
          {followUp.enabled ? (
            <div className="stack" style={{ marginTop: 14, gap: 12 }}>
              {followUp.delaysMinutes.slice(0, followUp.maxAttempts).map((minutes, index) => {
                const ui = delayUi(minutes);
                return (
                  <div key={index} className="row" style={{ gap: 12, alignItems: "end", flexWrap: "wrap" }}>
                    <label>
                      {index === 0 ? uiText("Первый повтор") : index === 1 ? uiText("Второй") : uiText("{p0}-й", {p0: index + 1})}
                      <input
                        type="number"
                        min={1}
                        max={ui.unit === "days" ? 30 : 72}
                        value={ui.value}
                        onChange={(event) => {
                          const next = [...followUp.delaysMinutes];
                          next[index] = delayMinutes(Number(event.target.value), ui.unit);
                          setFollowUp((prev) => ({ ...prev, delaysMinutes: next }));
                        }}
                      />
                    </label>
                    <label>
                      {uiText("Через")}<select
                        value={ui.unit}
                        onChange={(event) => {
                          const unit = event.target.value === "days" ? "days" : "hours";
                          const next = [...followUp.delaysMinutes];
                          next[index] = delayMinutes(ui.value, unit);
                          setFollowUp((prev) => ({ ...prev, delaysMinutes: next }));
                        }}
                      >
                        <option value="hours">{uiText("часов")}</option>
                        <option value="days">{uiText("дней")}</option>
                      </select>
                    </label>
                  </div>
                );
              })}
              <label>
                {uiText("Максимум повторов")}<select
                  value={followUp.maxAttempts}
                  onChange={(event) => {
                    const maxAttempts = Number(event.target.value);
                    const delaysMinutes = [...followUp.delaysMinutes];
                    const last = delaysMinutes[delaysMinutes.length - 1] || 1440;
                    while (delaysMinutes.length < maxAttempts) delaysMinutes.push(last);
                    setFollowUp((prev) => ({ ...prev, maxAttempts, delaysMinutes }));
                  }}
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check-row">
                <input type="checkbox" checked={followUp.skipIfRefused} onChange={(e) => setFollowUp((p) => ({ ...p, skipIfRefused: e.target.checked }))} />
                <span>{uiText("Не писать после явного отказа клиента")}</span>
              </label>
              <label className="check-row">
                <input type="checkbox" checked={followUp.skipIfHandedToHuman} onChange={(e) => setFollowUp((p) => ({ ...p, skipIfHandedToHuman: e.target.checked }))} />
                <span>{uiText("Не писать после передачи менеджеру")}</span>
              </label>
              <label className="check-row">
                <input type="checkbox" checked={followUp.skipIfDealClosed} onChange={(e) => setFollowUp((p) => ({ ...p, skipIfDealClosed: e.target.checked }))} />
                <span>{uiText("Не писать после закрытия сделки")}</span>
              </label>
              <label className="check-row">
                <input type="checkbox" checked={followUp.skipIfClientReplied} onChange={(e) => setFollowUp((p) => ({ ...p, skipIfClientReplied: e.target.checked }))} />
                <span>{uiText("Не писать, если клиент уже ответил")}</span>
              </label>
              <label className="check-row">
                <input type="checkbox" checked={followUp.respectWorkingHours} onChange={(e) => setFollowUp((p) => ({ ...p, respectWorkingHours: e.target.checked }))} />
                <span>{uiText("Учитывать рабочее время")}</span>
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      {section === "hours" ? (
        <div className="panel">
          <b>{text("Когда отвечать", "Қашан жауап беру", "When to reply")}</b>
          <p className="muted">{text("Укажите дни и часы для автоматических ответов. Используется часовой пояс компании.", "Автоматты жауаптардың күндері мен уақытын көрсетіңіз. Компанияның уақыт белдеуі қолданылады.", "Choose days and hours for automatic replies in your company’s time zone.")}</p>
          <div className="stack" style={{ gap: 10 }}>
            <label className="radio-row">
              <input
                type="radio"
                name="hoursMode"
                checked={conversationHours.mode === "always"}
                onChange={() => setConversationHours((prev) => ({ ...prev, mode: "always" }))}
              />
              <span>
                <b>{uiText("Круглосуточно")}</b>
                <div className="muted">{uiText("AI может отвечать в любое время.")}</div>
              </span>
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="hoursMode"
                checked={conversationHours.mode === "schedule"}
                onChange={() => setConversationHours((prev) => ({ ...prev, mode: "schedule" }))}
              />
              <span>
                <b>{uiText("По расписанию")}</b>
                <div className="muted">{uiText("Вне окна действует правило ниже.")}</div>
              </span>
            </label>
          </div>
          <label>
            {uiText("Часовой пояс")}<select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
              {(TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </select>
          </label>
          {conversationHours.mode === "schedule" ? (
            <>
              <div className="stack" style={{ marginTop: 12, gap: 8 }}>
                {localizeUiOptions(WEEK_DAYS, uiText).map((day) => {
                  const row = conversationHours.days[day.value] || DEFAULT_HOURS.days[day.value];
                  return (
                    <div key={day.value} className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                      <label className="check-row" style={{ minWidth: 160 }}>
                        <input
                          type="checkbox"
                          checked={row.enabled}
                          onChange={(event) =>
                            setConversationHours((prev) => ({
                              ...prev,
                              days: { ...prev.days, [day.value]: { ...row, enabled: event.target.checked } },
                            }))
                          }
                        />
                        <span>{day.label}</span>
                      </label>
                      {row.enabled ? (
                        <>
                          <label>
                            {uiText("С")}<input
                              type="time"
                              value={row.start}
                              onChange={(event) =>
                                setConversationHours((prev) => ({
                                  ...prev,
                                  days: { ...prev.days, [day.value]: { ...row, start: event.target.value || row.start } },
                                }))
                              }
                            />
                          </label>
                          <label>
                            {uiText("До")}<input
                              type="time"
                              value={row.end}
                              onChange={(event) =>
                                setConversationHours((prev) => ({
                                  ...prev,
                                  days: { ...prev.days, [day.value]: { ...row, end: event.target.value || row.end } },
                                }))
                              }
                            />
                          </label>
                        </>
                      ) : (
                        <span className="muted">{uiText("Выходной")}</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="stack" style={{ marginTop: 16, gap: 10 }}>
                <b>{uiText("Вне рабочего времени")}</b>
                <label className="radio-row">
                  <input
                    type="radio"
                    name="offHours"
                    checked={conversationHours.offHoursBehavior === "continue"}
                    onChange={() => setConversationHours((prev) => ({ ...prev, offHoursBehavior: "continue" }))}
                  />
                  <span>{uiText("AI продолжает отвечать")}</span>
                </label>
                <label className="radio-row">
                  <input
                    type="radio"
                    name="offHours"
                    checked={conversationHours.offHoursBehavior === "no_reply"}
                    onChange={() => setConversationHours((prev) => ({ ...prev, offHoursBehavior: "no_reply" }))}
                  />
                  <span>{text("Сохранить сообщение и ответить в рабочее время", "Хабарламаны сақтап, жұмыс уақытында жауап беру", "Save the message and reply during working hours")}</span>
                </label>
                <label className="radio-row">
                  <input
                    type="radio"
                    name="offHours"
                    checked={conversationHours.offHoursBehavior === "accept_no_process"}
                    onChange={() => setConversationHours((prev) => ({ ...prev, offHoursBehavior: "accept_no_process" }))}
                  />
                  <span>{text("Анализировать без ответа, ответить в рабочее время", "Жауапсыз талдап, жұмыс уақытында жауап беру", "Analyze without replying, reply during working hours")}</span>
                </label>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <div className={`actions workspace-save-bar${dirty ? " has-changes" : ""}`}>
        <span className="muted">{dirty ? text("Есть несохранённые изменения", "Сақталмаған өзгерістер бар", "Unsaved changes") : text("Все изменения сохранены", "Барлық өзгерістер сақталған", "All changes saved")}</span>
        <button className="btn" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? text("Сохраняю…", "Сақталуда…", "Saving…") : uiText("Сохранить")}</button>
        {dirty && <button type="button" className="btn secondary" disabled={busy} onClick={async () => { setBusy(true); await load(); setBusy(false); }}>{text("Отменить изменения", "Өзгерістерді болдырмау", "Discard changes")}</button>}
      </div>
      </fieldset>
    </section>
  );
}
