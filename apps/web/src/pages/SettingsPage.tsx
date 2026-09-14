import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { LegalSettingsPanel } from "./LegalSettingsPanel";
import { api } from "../lib/api";
import { formatDateTime } from "../lib/datetime";
import { useSession } from "../lib/session";
import { normalizeLocale, t, type Locale } from "../i18n";
import { notifySaved } from "../components/SaveNotice";
import {
  currentBrowserPermission,
  getBrowserNotificationPreference,
  requestBrowserNotificationPermission,
  setBrowserNotificationPreference,
} from "../lib/browserNotifications";

type Section =
  | "profile"
  | "security"
  | "notifications"
  | "interface"
  | "company"
  | "members"
  | "ai"
  | "tasks"
  | "integrations";

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="field-error">{message}</p>;
}

function useUnsaved(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);
}

export function SettingsPage() {
  const { me, caps } = useSession();
  const locale = normalizeLocale(me?.user?.locale);
  const [params, setParams] = useSearchParams();
  const requested = (params.get("section") || "profile") as Section;
  const allowedCompany: Section[] = [
    ...(caps.documents || caps.companyAdmin ? (["company"] as const) : []),
    ...(caps.members ? (["members"] as const) : []),
    ...(caps.aiSettings ? (["ai"] as const) : []),
    ...(!caps.manager ? (["tasks"] as const) : []),
    ...(caps.integrations || caps.companyAdmin ? (["integrations"] as const) : []),
  ];
  const personal: Section[] = ["profile", "security", "notifications", "interface"];
  const section = [...personal, ...allowedCompany].includes(requested) ? requested : "profile";

  const items: Array<{ id: Section; group: "personal" | "company"; label: string; to?: string }> = [
    { id: "profile", group: "personal", label: t(locale, "settings.profile") },
    { id: "security", group: "personal", label: t(locale, "settings.security") },
    { id: "notifications", group: "personal", label: t(locale, "settings.notifications") },
    { id: "interface", group: "personal", label: t(locale, "settings.interface") },
    ...(caps.documents || caps.companyAdmin
      ? [{ id: "company" as const, group: "company" as const, label: t(locale, "settings.legal") }]
      : []),
    ...(caps.members ? [{ id: "members" as const, group: "company" as const, label: t(locale, "settings.members") }] : []),
    ...(caps.aiSettings ? [{ id: "ai" as const, group: "company" as const, label: t(locale, "settings.ai"), to: "/settings/ai-automation" }] : []),
    ...(!caps.manager ? [{ id: "tasks" as const, group: "company" as const, label: t(locale, "settings.tasks"), to: "/control" }] : []),
    ...(caps.integrations || caps.companyAdmin
      ? [{ id: "integrations" as const, group: "company" as const, label: t(locale, "settings.integrations"), to: "/integrations" }]
      : []),
  ];

  return (
    <section className="settings-page">
      <h2>{t(locale, "settings.title")}</h2>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t(locale, "settings.title")}>
          <p className="nav-section">{t(locale, "settings.personal")}</p>
          {items.filter((item) => item.group === "personal").map((item) => (
            <button
              key={item.id}
              type="button"
              className={section === item.id ? "active" : ""}
              onClick={() => setParams({ section: item.id })}
            >
              {item.label}
            </button>
          ))}
          {items.some((item) => item.group === "company") ? (
            <>
              <p className="nav-section">{t(locale, "settings.company")}</p>
              {items.filter((item) => item.group === "company").map((item) =>
                item.to ? (
                  <Link key={item.id} to={item.to}>
                    {item.label}
                  </Link>
                ) : (
                  <button
                    key={item.id}
                    type="button"
                    className={section === item.id ? "active" : ""}
                    onClick={() => setParams({ section: item.id })}
                  >
                    {item.label}
                  </button>
                ),
              )}
            </>
          ) : null}
        </nav>
        <div className="settings-body">
          {section === "profile" ? <ProfileSection locale={locale} /> : null}
          {section === "security" ? <SecuritySection locale={locale} /> : null}
          {section === "notifications" ? <NotificationsSection locale={locale} /> : null}
          {section === "interface" ? <InterfaceSection locale={locale} /> : null}
          {section === "company" && (caps.documents || caps.companyAdmin) ? <LegalSettingsPanel /> : null}
          {section === "members" && caps.members ? <MembersSection locale={locale} /> : null}
        </div>
      </div>
    </section>
  );
}

function ProfileSection({ locale }: { locale: Locale }) {
  const { me } = useSession();
  const [status, setStatus] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  useUnsaved(dirty);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setErrors({});
    try {
      await api.updateProfile({
        firstName: form.get("firstName"),
        lastName: form.get("lastName"),
        middleName: form.get("middleName"),
        phone: form.get("phone"),
        city: form.get("city"),
      });
      setDirty(false);
      setStatus(t(locale, "settings.saved"));
      notifySaved("Профиль сохранён");
      window.location.reload();
    } catch (err: any) {
      const field = err?.body?.field_errors || {};
      setErrors(field);
      setStatus(err instanceof Error ? err.message : "Ошибка");
    }
  }

  async function onAvatar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = (event.currentTarget.elements.namedItem("avatar") as HTMLInputElement)?.files?.[0];
    if (!file) return;
    const contentBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        resolve(result.includes(",") ? result.split(",")[1] : result);
      };
      reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
      reader.readAsDataURL(file);
    });
    await api.uploadAvatar({ contentBase64, mimeType: file.type });
    notifySaved("Фото обновлено");
    window.location.reload();
  }

  return (
    <>
      <form className="panel" onSubmit={onAvatar}>
        <b>Фото</b>
        {me?.user?.hasAvatar ? <img className="avatar-preview" src="/api/v1/me/avatar" alt="" /> : <p className="muted">Фото не загружено</p>}
        <input name="avatar" type="file" accept="image/jpeg,image/png,image/webp" />
        <button className="btn secondary" type="submit">Загрузить</button>
      </form>
      <form
        className="panel"
        onChange={() => setDirty(true)}
        onSubmit={onSubmit}
      >
        <b>{t(locale, "settings.profile")}</b>
        <label>
          {t(locale, "settings.firstName")}
          <input name="firstName" defaultValue={me?.user?.firstName || ""} />
          <FieldError message={errors.firstName} />
        </label>
        <label>
          {t(locale, "settings.lastName")}
          <input name="lastName" defaultValue={me?.user?.lastName || ""} />
        </label>
        <label>
          {t(locale, "settings.middleName")}
          <input name="middleName" defaultValue={me?.user?.middleName || ""} />
        </label>
        <label>
          {t(locale, "settings.phone")}
          <input name="phone" defaultValue={me?.user?.phone || ""} />
        </label>
        <label>
          {t(locale, "settings.city")}
          <input name="city" defaultValue={me?.user?.city || ""} />
        </label>
        <label>
          Email
          <input value={me?.user?.email || ""} readOnly />
        </label>
        <p className="muted">Email используется для входа и меняется только через подтверждение нового адреса.</p>
        <label>
          Должность в компании
          <input value={me?.activeTenant?.jobTitle || me?.activeTenant?.roleLabel || ""} readOnly />
        </label>
        <p className="muted">Должность в компании меняет администратор или директор.</p>
        {status ? <p className="ok">{status}</p> : null}
        <button className="btn">{t(locale, "settings.save")}</button>
      </form>
    </>
  );
}

function SecuritySection({ locale }: { locale: Locale }) {
  const { me } = useSession();
  const [status, setStatus] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<any[]>([]);

  async function loadSessions() {
    const data = (await api.sessions()) as { items: any[] };
    setSessions(data.items || []);
  }

  useEffect(() => {
    void loadSessions();
  }, []);

  async function onPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setErrors({});
    try {
      await api.changePassword({
        currentPassword: form.get("currentPassword"),
        newPassword: form.get("newPassword"),
        confirmPassword: form.get("confirmPassword"),
      });
      setStatus("Пароль изменён. Остальные сессии завершены.");
      event.currentTarget.reset();
      await loadSessions();
    } catch (err: any) {
      setErrors(err?.body?.field_errors || {});
      setStatus(err instanceof Error ? err.message : "Ошибка");
    }
  }

  return (
    <>
      <form className="panel" onSubmit={onPassword}>
        <b>Смена пароля</b>
        <label>
          Текущий пароль
          <input name="currentPassword" type="password" autoComplete="current-password" required />
          <FieldError message={errors.currentPassword} />
        </label>
        <label>
          Новый пароль
          <input name="newPassword" type="password" autoComplete="new-password" required />
        </label>
        <label>
          Повтор
          <input name="confirmPassword" type="password" autoComplete="new-password" required />
          <FieldError message={errors.confirmPassword} />
        </label>
        {status ? <p>{status}</p> : null}
        <button className="btn" type="submit">Сменить пароль</button>
      </form>
      <div className="panel">
        <div className="page-head">
          <b>Активные сессии</b>
          <button
            type="button"
            className="btn secondary"
            onClick={() => void api.revokeOtherSessions().then(loadSessions)}
          >
            Выйти со всех устройств
          </button>
        </div>
        {sessions.map((item) => (
          <div className="row" key={item.id}>
            <div>
              <b>
                {item.title}
                {item.current ? " · текущая" : ""}
              </b>
              <div className="muted">
                {item.lastSeenAt
                  ? `Активность: ${formatDateTime(item.lastSeenAt, { timeZone: me?.user?.timezone, timeFormat: me?.user?.timeFormat, locale })}`
                  : "Последняя активность неизвестна"}
                {item.ip ? ` · ${item.ip}` : ""}
              </div>
            </div>
            {!item.current ? (
              <button type="button" className="btn secondary" onClick={() => void api.revokeSession(item.id).then(loadSessions)}>
                Завершить
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </>
  );
}

function NotificationsSection({ locale }: { locale: Locale }) {
  const { caps } = useSession();
  const [prefs, setPrefs] = useState<any>(null);
  const [notices, setNotices] = useState<any[]>([]);
  const [permission, setPermission] = useState(currentBrowserPermission());
  const [enabled, setEnabled] = useState(getBrowserNotificationPreference());
  const [status, setStatus] = useState("");

  async function load() {
    const [p, n] = await Promise.all([
      api.notificationPreferences(),
      api.notifications().catch(() => ({ items: [] })),
    ]);
    setPrefs(p);
    const data = n as { items?: any[] } | any[];
    setNotices(Array.isArray(data) ? data : data.items || []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(next: any) {
    const saved = await api.updateNotificationPreferences(next);
    setPrefs(saved);
    setStatus(t(locale, "settings.saved"));
  }

  if (!prefs) return <div className="state">{t(locale, "common.loading")}</div>;

  const events: Array<[string, string]> = [
    ["new_inquiries", "Новые доступные заявки"],
    ["assignment", "Назначение заявки или сделки"],
    ["dialogs", "Новые сообщения в доступных диалогах"],
    ["tasks", "Назначенные задачи и напоминания"],
    ["deals", "Изменения доступных сделок"],
    ["ai_events", "События AI, требующие участия"],
    ...(!caps.manager ? [["management", "Управленческие уведомления"] as [string, string]] : []),
  ];

  return (
    <>
      <form
        className="panel"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const nextEvents: Record<string, boolean> = {};
          for (const [key] of events) nextEvents[key] = form.get(`event_${key}`) === "on";
          void save({
            events: nextEvents,
            channels: { in_app: form.get("ch_in_app") === "on", web_push: form.get("ch_web_push") === "on" },
            quietHours: {
              enabled: form.get("quiet") === "on",
              start: form.get("quietStart"),
              end: form.get("quietEnd"),
            },
          });
        }}
      >
        <b>Категории</b>
        {events.map(([key, label]) => (
          <label key={key} className="check-row">
            <input type="checkbox" name={`event_${key}`} defaultChecked={prefs.events?.[key] !== false} />
            {label}
          </label>
        ))}
        <b>Каналы</b>
        <label className="check-row">
          <input type="checkbox" name="ch_in_app" defaultChecked={prefs.channels?.in_app !== false} />
          В кабинете
        </label>
        <label className="check-row">
          <input type="checkbox" name="ch_web_push" defaultChecked={prefs.channels?.web_push !== false} />
          Браузерные уведомления
        </label>
        <p className="muted">Email, Telegram и WhatsApp для личных уведомлений появятся после полноценного подключения канала.</p>
        <b>Время тишины (внешние уведомления)</b>
        <label className="check-row">
          <input type="checkbox" name="quiet" defaultChecked={Boolean(prefs.quietHours?.enabled)} />
          Включить
        </label>
        <label>
          С
          <input name="quietStart" type="time" defaultValue={prefs.quietHours?.start || "22:00"} />
        </label>
        <label>
          До
          <input name="quietEnd" type="time" defaultValue={prefs.quietHours?.end || "08:00"} />
        </label>
        {status ? <p className="ok">{status}</p> : null}
        <button className="btn">{t(locale, "settings.save")}</button>
      </form>

      <div className="panel">
        <b>Уведомления браузера</b>
        <p>
          Статус: <b>{permission}</b>
          {enabled ? " · включены в кабинете" : " · выключены в кабинете"}
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              void requestBrowserNotificationPermission().then((result) => {
                setPermission(result);
                if (result === "granted") {
                  setEnabled(true);
                  setBrowserNotificationPreference(true);
                }
              });
            }}
          >
            Разрешить уведомления
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={() => {
              const next = !enabled;
              setBrowserNotificationPreference(next);
              setEnabled(next);
            }}
          >
            {enabled ? "Выключить в кабинете" : "Включить в кабинете"}
          </button>
        </div>
      </div>

      <div className="panel">
        <b>Последние уведомления</b>
        {notices.slice(0, 20).map((item) => (
          <div className="row" key={item.id}>
            <div>
              <b>{item.title}</b>
              <div className="muted">{item.body}</div>
            </div>
            <Link className="btn secondary" to={item.href || "/today"}>
              Открыть
            </Link>
          </div>
        ))}
      </div>
    </>
  );
}

function InterfaceSection({ locale }: { locale: Locale }) {
  const { me } = useSession();
  const [status, setStatus] = useState("");
  const [dirty, setDirty] = useState(false);
  useUnsaved(dirty);

  return (
    <form
      className="panel"
      onChange={() => setDirty(true)}
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        await api.updateAppearance({
          locale: form.get("locale"),
          timezone: form.get("timezone"),
          timeFormat: form.get("timeFormat"),
          theme: form.get("theme"),
        });
        setDirty(false);
        setStatus(t(locale, "settings.saved"));
        window.location.reload();
      }}
    >
      <b>{t(locale, "settings.interface")}</b>
      <label>
        {t(locale, "settings.language")}
        <select name="locale" defaultValue={me?.user?.locale || "ru"}>
          <option value="ru">Русский</option>
          <option value="kk">Қазақша</option>
          <option value="en">English</option>
        </select>
      </label>
      <label>
        {t(locale, "settings.timezone")}
        <input name="timezone" defaultValue={me?.user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone} />
      </label>
      <p className="muted">Личный часовой пояс меняет отображение времени. Автоматизация компании использует пояс организации.</p>
      <label>
        {t(locale, "settings.timeFormat")}
        <select name="timeFormat" defaultValue={me?.user?.timeFormat || "24"}>
          <option value="24">24 часа</option>
          <option value="12">12 часов</option>
        </select>
      </label>
      <label>
        {t(locale, "settings.theme")}
        <select name="theme" defaultValue={me?.user?.theme || "system"}>
          <option value="light">Светлая</option>
          <option value="dark">Тёмная</option>
          <option value="system">Системная</option>
        </select>
      </label>
      {status ? <p className="ok">{status}</p> : null}
      <button className="btn">{t(locale, "settings.save")}</button>
    </form>
  );
}

function MembersSection({ locale }: { locale: Locale }) {
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState("");

  async function load() {
    const data = (await api.companyMembers()) as { items: any[] };
    setItems(data.items || []);
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
  }, []);

  return (
    <div className="panel">
      <b>{t(locale, "settings.members")}</b>
      {error ? <p className="error">{error}</p> : null}
      {items.map((item) => (
        <form
          key={item.id}
          className="row"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            await api.updateCompanyMember(item.id, {
              role: form.get("role"),
              jobTitle: form.get("jobTitle"),
            });
            notifySaved("Сотрудник обновлён");
            await load();
          }}
        >
          <div>
            <b>{item.name}</b>
            <div className="muted">{item.email}</div>
            <input name="jobTitle" defaultValue={item.jobTitle || ""} placeholder="Должность" />
            <select name="role" defaultValue={item.role}>
              <option value="owner">Администратор компании</option>
              <option value="director">Директор</option>
              <option value="sales_lead">Руководитель продаж</option>
              <option value="manager">Менеджер</option>
            </select>
          </div>
          <button className="btn secondary">{t(locale, "settings.save")}</button>
        </form>
      ))}
    </div>
  );
}
