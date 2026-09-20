import { notifySaved } from "../components/SaveNotice";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

const MODE_HELP: Record<string, string> = {
  MANUAL: "Заявка сохраняется. AI её не разбирает и клиенту не пишет.",
  ASSIST: "AI разбирает заявку и показывает подсказку. Клиенту не пишет.",
  CONFIRM: "AI готовит задачу и ждёт, пока вы нажмёте «Начать обработку».",
  AUTO: "AI разбирает заявку и сам пишет клиенту, если WhatsApp подключён.",
};

type SettingsSection = "requests" | "prompt" | "knowledge" | "handoff" | "followup" | "hours";

const SECTION_ITEMS: Array<{ id: SettingsSection; label: string }> = [
  { id: "requests", label: "Новые заявки" },
  { id: "prompt", label: "Промпт" },
  { id: "knowledge", label: "База знаний" },
  { id: "handoff", label: "Передача менеджеру" },
  { id: "followup", label: "Повторный контакт" },
  { id: "hours", label: "Рабочее время" },
];

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

const DAY_OPTIONS = [
  { value: 1, label: "Пн" },
  { value: 2, label: "Вт" },
  { value: 3, label: "Ср" },
  { value: 4, label: "Чт" },
  { value: 5, label: "Пт" },
  { value: 6, label: "Сб" },
  { value: 0, label: "Вс" },
];

type ScheduleWindow = { days: number[]; start: string; end: string };

const DEFAULT_WORKING: ScheduleWindow = { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" };
const DEFAULT_CUSTOM: ScheduleWindow = { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "20:00" };

function ScheduleEditor({
  value,
  onChange,
  timezone,
}: {
  value: ScheduleWindow;
  onChange: (next: ScheduleWindow) => void;
  timezone: string;
}) {
  function toggleDay(day: number) {
    const has = value.days.includes(day);
    const days = has ? value.days.filter((d) => d !== day) : [...value.days, day].sort((a, b) => a - b);
    onChange({ ...value, days: days.length ? days : value.days });
  }

  return (
    <div className="stack" style={{ marginTop: 10, gap: 10 }}>
      <div className="muted">Часовой пояс: {timezone}</div>
      <div className="actions" style={{ flexWrap: "wrap" }}>
        {DAY_OPTIONS.map((d) => (
          <button
            key={d.value}
            type="button"
            className={value.days.includes(d.value) ? "btn" : "btn secondary"}
            onClick={() => toggleDay(d.value)}
          >
            {d.label}
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 12, alignItems: "end" }}>
        <label>
          С
          <input
            type="time"
            value={value.start}
            onChange={(e) => onChange({ ...value, start: e.target.value || value.start })}
          />
        </label>
        <label>
          До
          <input
            type="time"
            value={value.end}
            onChange={(e) => onChange({ ...value, end: e.target.value || value.end })}
          />
        </label>
      </div>
      <p className="muted">
        Вне окна AI всё ещё анализирует и готовит задачу, но не пишет клиенту сам — дождётся
        рабочего времени или кнопки менеджера.
      </p>
    </div>
  );
}

export function AiAutomationSettingsPage() {
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [section, setSection] = useState<SettingsSection>("requests");
  const [mode, setMode] = useState("CONFIRM");
  const [processRepeat, setProcessRepeat] = useState(true);
  const [sla, setSla] = useState(15);
  const [scheduleMode, setScheduleMode] = useState("always");
  const [workingHours, setWorkingHours] = useState<ScheduleWindow>(DEFAULT_WORKING);
  const [customSchedule, setCustomSchedule] = useState<ScheduleWindow>(DEFAULT_CUSTOM);
  const [timezone, setTimezone] = useState("Asia/Almaty");
  const [handoff, setHandoff] = useState<HandoffState>(DEFAULT_HANDOFF);
  const [followUp, setFollowUp] = useState<FollowUpState>(DEFAULT_FOLLOWUP);
  const [conversationHours, setConversationHours] = useState<ConversationHoursState>(DEFAULT_HOURS);

  async function load() {
    try {
      const next = (await api.aiAutomationSettings()) as {
        defaultMode: string;
        processRepeatRequests: boolean;
        firstContactSlaMinutes: number;
        scheduleMode: string;
        workingHours?: ScheduleWindow;
        customSchedule?: ScheduleWindow;
        timezone?: string;
        modes?: Array<{ mode: string; label: string }>;
        sourceModes?: Record<string, string>;
        serviceModes?: Record<string, string>;
        allowProactiveOutbound?: boolean;
        handoff?: HandoffState;
        followUp?: FollowUpState;
        conversationHours?: ConversationHoursState;
      };
      setData(next);
      setMode(next.defaultMode);
      setProcessRepeat(Boolean(next.processRepeatRequests));
      setSla(Number(next.firstContactSlaMinutes) || 15);
      setScheduleMode(next.scheduleMode || "always");
      if (next.workingHours) setWorkingHours(next.workingHours);
      if (next.customSchedule) setCustomSchedule(next.customSchedule);
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
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    setHint("");
    try {
      const result = (await api.updateAiAutomationSettings({
        defaultMode: mode,
        processRepeatRequests: processRepeat,
        firstContactSlaMinutes: sla,
        scheduleMode,
        workingHours,
        customSchedule,
        timezone,
        handoff,
        followUp,
        conversationHours,
      })) as { message?: string };
      setHint(result.message || "Сохранено");
      setEditing(false);
      notifySaved("Настройки AI сохранены");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка сохранения");
    } finally {
      setBusy(false);
    }
  }

  if (!data && !error) return <div className="state">Загрузка настроек…</div>;

  return (
    <section>
      <div className="page-head">
        <div>
          <p className="page-kicker">
            <Link to="/settings">Настройки</Link> · AI-менеджер
          </p>
          <h2>AI-менеджер</h2>
          <p className="muted">
            Как компания обрабатывает заявки и диалоги. Текст ответов и база знаний задаёт администратор сервиса.
          </p>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {hint ? <p className="ok">{hint}</p> : null}

      <div className="actions task-board-tabs">
        {SECTION_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={section === item.id ? "btn" : "btn secondary"}
            onClick={() => setSection(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {!editing ? <div className="panel saved-editor-summary">
        <b>Настройки AI-менеджера сохранены</b>
        <button type="button" className="btn secondary" autoFocus onClick={() => { setEditing(true); setHint(""); }}>Изменить настройки</button>
      </div> : <>
      {section === "requests" ? (
        <>
      <p className="muted">Как обрабатывать новые заявки. Уже запущенные задачи не меняются.</p>
      <div className="panel">
        <b>Режим по умолчанию</b>
        <div className="stack" style={{ marginTop: 12, gap: 10 }}>
          {(data?.modes || []).map((item: { mode: string; label: string }) => (
            <label key={item.mode} className="radio-row">
              <input
                type="radio"
                name="aiMode"
                checked={mode === item.mode}
                onChange={() => setMode(item.mode)}
              />
              <span>
                <b>{item.label}</b>
                <div className="muted">{MODE_HELP[item.mode]}</div>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="panel">
        <label className="check-row">
          <input type="checkbox" checked={processRepeat} onChange={(e) => setProcessRepeat(e.target.checked)} />
          <span>Автоматически обрабатывать повторные заявки</span>
        </label>
        <label>
          Первичный контакт
          <select value={sla} onChange={(e) => setSla(Number(e.target.value))}>
            {[5, 10, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                до {m} минут
              </option>
            ))}
          </select>
        </label>
        <label>
          Автообработка
          <select value={scheduleMode} onChange={(e) => setScheduleMode(e.target.value)}>
            <option value="always">Всегда</option>
            <option value="working_hours">Только рабочее время</option>
            <option value="custom">По расписанию</option>
          </select>
        </label>
        {scheduleMode === "working_hours" ? (
          <ScheduleEditor value={workingHours} onChange={setWorkingHours} timezone={timezone} />
        ) : null}
        {scheduleMode === "custom" ? (
          <ScheduleEditor value={customSchedule} onChange={setCustomSchedule} timezone={timezone} />
        ) : null}
      </div>

      <button type="button" className="linkish" onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? "Скрыть дополнительные настройки" : "Дополнительные настройки"}
      </button>

      {showAdvanced ? (
        <div className="panel soft">
          <p className="muted">
            При режиме «Сам пишет клиенту» заявки с формы сайта тоже обрабатываются сразу: AI пишет
            приветствие на номер из заявки. Если номера нет в WhatsApp, это появится на Главной. Заявки, созданные вручную, AI сам не берёт.
          </p>
        </div>
      ) : null}
        </>
      ) : null}

      {section === "prompt" ? (
        <div className="panel">
          <b>Промпт</b>
          <p className="muted">
            Текст, по которому AI отвечает клиентам, задаёт администратор сервиса. Компания его здесь не меняет —
            чтобы не сломать уже работающие ответы.
          </p>
          <Link className="btn secondary" to="/settings">Назад</Link>
        </div>
      ) : null}

      {section === "knowledge" ? (
        <div className="panel">
          <b>База знаний</b>
          <p className="muted">
            Материалы о компании и услугах тоже задаёт администратор сервиса. Здесь их нельзя переписать.
          </p>
          <Link className="btn secondary" to="/settings">Назад</Link>
        </div>
      ) : null}

      {section === "handoff" ? (
        <div className="panel">
          <b>Передача менеджеру</b>
          <p className="muted">Когда AI должен перестать вести диалог сам и отдать его сотруднику.</p>
          <div className="stack" style={{ marginTop: 12, gap: 10 }}>
            {HANDOFF_OPTIONS.map((item) => (
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
            <b>После передачи</b>
            <label className="radio-row">
              <input
                type="radio"
                name="handoffAfter"
                checked={handoff.afterMode === "human"}
                onChange={() => setHandoff((prev) => ({ ...prev, afterMode: "human" }))}
              />
              <span>
                <b>AI прекращает отвечать</b>
                <div className="muted">Диалог забирает сотрудник. Бот клиенту больше не пишет.</div>
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
                <b>AI подсказывает менеджеру</b>
                <div className="muted">Клиенту не пишет, но оставляет подсказку сотруднику.</div>
              </span>
            </label>
          </div>
        </div>
      ) : null}

      {section === "followup" ? (
        <div className="panel">
          <b>Повторный контакт</b>
          <p className="muted">AI может повторно написать клиенту, если клиент перестал отвечать. Текст берётся из последнего разговора, не из шаблона.</p>
          <label className="check-row">
            <input
              type="checkbox"
              checked={followUp.enabled}
              onChange={(event) => setFollowUp((prev) => ({ ...prev, enabled: event.target.checked }))}
            />
            <span>Автоматический повторный контакт</span>
          </label>
          {followUp.enabled ? (
            <div className="stack" style={{ marginTop: 14, gap: 12 }}>
              {followUp.delaysMinutes.slice(0, followUp.maxAttempts).map((minutes, index) => {
                const ui = delayUi(minutes);
                return (
                  <div key={index} className="row" style={{ gap: 12, alignItems: "end", flexWrap: "wrap" }}>
                    <label>
                      {index === 0 ? "Первый повтор" : index === 1 ? "Второй" : `${index + 1}-й`}
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
                      Через
                      <select
                        value={ui.unit}
                        onChange={(event) => {
                          const unit = event.target.value === "days" ? "days" : "hours";
                          const next = [...followUp.delaysMinutes];
                          next[index] = delayMinutes(ui.value, unit);
                          setFollowUp((prev) => ({ ...prev, delaysMinutes: next }));
                        }}
                      >
                        <option value="hours">часов</option>
                        <option value="days">дней</option>
                      </select>
                    </label>
                  </div>
                );
              })}
              <label>
                Максимум повторов
                <select
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
                <span>Не писать после явного отказа клиента</span>
              </label>
              <label className="check-row">
                <input type="checkbox" checked={followUp.skipIfHandedToHuman} onChange={(e) => setFollowUp((p) => ({ ...p, skipIfHandedToHuman: e.target.checked }))} />
                <span>Не писать после передачи менеджеру</span>
              </label>
              <label className="check-row">
                <input type="checkbox" checked={followUp.skipIfDealClosed} onChange={(e) => setFollowUp((p) => ({ ...p, skipIfDealClosed: e.target.checked }))} />
                <span>Не писать после закрытия сделки</span>
              </label>
              <label className="check-row">
                <input type="checkbox" checked={followUp.skipIfClientReplied} onChange={(e) => setFollowUp((p) => ({ ...p, skipIfClientReplied: e.target.checked }))} />
                <span>Не писать, если клиент уже ответил</span>
              </label>
              <label className="check-row">
                <input type="checkbox" checked={followUp.respectWorkingHours} onChange={(e) => setFollowUp((p) => ({ ...p, respectWorkingHours: e.target.checked }))} />
                <span>Учитывать рабочее время</span>
              </label>
            </div>
          ) : null}
        </div>
      ) : null}

      {section === "hours" ? (
        <div className="panel">
          <b>Рабочее время</b>
          <p className="muted">Когда AI отвечает сам. Часовой пояс компании, не сервера. Пока включено «Круглосуточно», расписание новых заявок из вкладки «Новые заявки» не меняется.</p>
          <div className="stack" style={{ gap: 10 }}>
            <label className="radio-row">
              <input
                type="radio"
                name="hoursMode"
                checked={conversationHours.mode === "always"}
                onChange={() => setConversationHours((prev) => ({ ...prev, mode: "always" }))}
              />
              <span>
                <b>Круглосуточно</b>
                <div className="muted">AI может отвечать в любое время.</div>
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
                <b>По расписанию</b>
                <div className="muted">Вне окна действует правило ниже.</div>
              </span>
            </label>
          </div>
          <label>
            Часовой пояс
            <select value={timezone} onChange={(event) => setTimezone(event.target.value)}>
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
                {WEEK_DAYS.map((day) => {
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
                            С
                            <input
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
                            До
                            <input
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
                        <span className="muted">Выходной</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="stack" style={{ marginTop: 16, gap: 10 }}>
                <b>Вне рабочего времени</b>
                <label className="radio-row">
                  <input
                    type="radio"
                    name="offHours"
                    checked={conversationHours.offHoursBehavior === "continue"}
                    onChange={() => setConversationHours((prev) => ({ ...prev, offHoursBehavior: "continue" }))}
                  />
                  <span>AI продолжает отвечать</span>
                </label>
                <label className="radio-row">
                  <input
                    type="radio"
                    name="offHours"
                    checked={conversationHours.offHoursBehavior === "accept_no_process"}
                    onChange={() => setConversationHours((prev) => ({ ...prev, offHoursBehavior: "accept_no_process" }))}
                  />
                  <span>AI принимает обращение, но не начинает полноценную обработку</span>
                </label>
                <label className="radio-row">
                  <input
                    type="radio"
                    name="offHours"
                    checked={conversationHours.offHoursBehavior === "no_reply"}
                    onChange={() => setConversationHours((prev) => ({ ...prev, offHoursBehavior: "no_reply" }))}
                  />
                  <span>AI не отвечает</span>
                </label>
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {section === "prompt" || section === "knowledge" ? null : (
      <div className="actions">
        <button className="btn" disabled={busy} onClick={() => void save()}>
          Сохранить
        </button>
        <Link className="btn secondary" to="/settings">
          Назад
        </Link>
      </div>
      )}
      </>}
    </section>
  );
}
