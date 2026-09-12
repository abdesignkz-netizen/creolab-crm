import { notifySaved } from "../components/SaveNotice";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

const MODE_HELP: Record<string, string> = {
  MANUAL: "Заявка сохраняется. Без AI-анализа и без AI-задачи.",
  ASSIST: "AI анализирует заявку и показывает подсказку. Клиенту не пишет.",
  CONFIRM: "AI готовит задачу и ждёт кнопку «Начать обработку».",
  AUTO: "AI анализирует, создаёт задачу и сам начинает контакт, если канал доступен.",
};

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
  const [mode, setMode] = useState("CONFIRM");
  const [processRepeat, setProcessRepeat] = useState(true);
  const [sla, setSla] = useState(15);
  const [scheduleMode, setScheduleMode] = useState("always");
  const [workingHours, setWorkingHours] = useState<ScheduleWindow>(DEFAULT_WORKING);
  const [customSchedule, setCustomSchedule] = useState<ScheduleWindow>(DEFAULT_CUSTOM);
  const [timezone, setTimezone] = useState("Asia/Almaty");

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
      };
      setData(next);
      setMode(next.defaultMode);
      setProcessRepeat(Boolean(next.processRepeatRequests));
      setSla(Number(next.firstContactSlaMinutes) || 15);
      setScheduleMode(next.scheduleMode || "always");
      if (next.workingHours) setWorkingHours(next.workingHours);
      if (next.customSchedule) setCustomSchedule(next.customSchedule);
      setTimezone(next.timezone || "Asia/Almaty");
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
            <Link to="/settings">Настройки</Link> · AI Manager
          </p>
          <h2>Новые заявки</h2>
          <p className="muted">Уровень автоматизации для входящих Request. Уже запущенные AI-задачи не меняются.</p>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {hint ? <p className="ok">{hint}</p> : null}

      {!editing ? <div className="panel saved-editor-summary">
        <b>Настройки обработки заявок сохранены</b>
        <button type="button" className="btn secondary" autoFocus onClick={() => { setEditing(true); setHint(""); }}>Изменить настройки</button>
      </div> : <>
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
            Безопасный default: «AI после подтверждения». Исключения по источникам (Manual → Ручной, API →
            AI-подсказки) уже в backend. Полный автомат для Website Form включайте осознанно через режим или
            sourceModes.
          </p>
          <pre className="code">{JSON.stringify({
            sourceModes: data?.sourceModes,
            serviceModes: data?.serviceModes,
            allowProactiveOutbound: data?.allowProactiveOutbound,
            scheduleMode,
            workingHours,
            customSchedule,
          }, null, 2)}</pre>
        </div>
      ) : null}

      <div className="actions">
        <button className="btn" disabled={busy} onClick={() => void save()}>
          Сохранить
        </button>
        <Link className="btn secondary" to="/settings">
          Назад
        </Link>
      </div>
      </>}
    </section>
  );
}
