import { uiNotificationBody, uiText, useUiText, localizeUiOptions, uiMessage } from "../lib/uiText";
import { DocumentNumberingPanel } from "./DocumentNumberingPanel";
import { ServiceCatalogPanel } from "./ServiceCatalogPanel";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { LegalSettingsPanel } from "./LegalSettingsPanel";
import { api } from "../lib/api";
import { PasswordInput } from "../components/PasswordInput";
import { formatDateTime } from "../lib/datetime";
import { useSession } from "../lib/session";
import { normalizeLocale, accountErrorMessage, t, type Locale } from "../i18n";
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
  | "services"
  | "company"
  | "members"
  | "ops"
  | "audit"
  | "control"
  | "ai"
  | "tasks"
  | "integrations"
  | "billing";

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
    ...(caps.companyAdmin ? (["services", "ops", "audit", "control"] as const) : []),
    ...(caps.aiSettings ? (["ai"] as const) : []),
    ...(!caps.manager ? (["tasks"] as const) : []),
    ...(caps.integrations || caps.companyAdmin ? (["integrations"] as const) : []),
    "billing" as const,
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
    ...(caps.companyAdmin
      ? [
          { id: "services" as const, group: "company" as const, label: t(locale, "settings.services") },
          { id: "ops" as const, group: "company" as const, label: t(locale, "settings.ops") },
          { id: "audit" as const, group: "company" as const, label: t(locale, "settings.audit") },
          { id: "control" as const, group: "company" as const, label: t(locale, "settings.control") },
        ]
      : []),
    ...(caps.aiSettings ? [{ id: "ai" as const, group: "company" as const, label: t(locale, "settings.ai"), to: "/settings/ai-automation" }] : []),
    ...(!caps.manager ? [{ id: "tasks" as const, group: "company" as const, label: t(locale, "settings.tasks"), to: "/control" }] : []),
    ...(caps.integrations || caps.companyAdmin
      ? [{ id: "integrations" as const, group: "company" as const, label: t(locale, "settings.integrations"), to: "/integrations" }]
      : []),
    { id: "billing" as const, group: "company" as const, label: t(locale, "settings.billing"), to: "/billing" },
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
          {section === "company" && (caps.documents || caps.companyAdmin) ? <><LegalSettingsPanel /><DocumentNumberingPanel /></> : null}
          {section === "members" && caps.members ? <MembersSection locale={locale} /> : null}
          {section === "services" && caps.companyAdmin ? <ServiceCatalogPanel /> : null}
          {section === "ops" && caps.companyAdmin ? <OpsSection locale={locale} /> : null}
          {section === "audit" && caps.companyAdmin ? <AuditSection locale={locale} /> : null}
          {section === "control" && caps.companyAdmin ? <ControlSection locale={locale} /> : null}
        </div>
      </div>
    </section>
  );
}

function ProfileSection({ locale }: { locale: Locale }) {
  const { me } = useSession();
  const [status, setStatus] = useState("");
  const [avatarError, setAvatarError] = useState("");
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
      notifySaved(t(locale, "settings.profileSaved"));
      window.location.reload();
    } catch (err: any) {
      const field = err?.body?.field_errors || {};
      setErrors(Object.fromEntries(Object.entries(field).map(([key, value]) => [key, accountErrorMessage(locale, String(value))])));
      setStatus(accountErrorMessage(locale, err instanceof Error ? err.message : undefined));
    }
  }

  async function onAvatar(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = (event.currentTarget.elements.namedItem("avatar") as HTMLInputElement)?.files?.[0];
    if (!file) return;
    setAvatarError("");
    try {
      const contentBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || "");
          resolve(result.includes(",") ? result.split(",")[1] : result);
        };
        reader.onerror = () => reject(new Error(t(locale, "settings.fileReadError")));
        reader.readAsDataURL(file);
      });
      await api.uploadAvatar({ contentBase64, mimeType: file.type });
      notifySaved(t(locale, "settings.photoUpdated"));
      window.location.reload();
    } catch (err) {
      setAvatarError(accountErrorMessage(locale, err instanceof Error ? err.message : undefined));
    }
  }

  return (
    <>
      <form className="panel" onSubmit={onAvatar}>
        <b>{t(locale, "settings.photo")}</b>
        {me?.user?.hasAvatar ? <img className="avatar-preview" src="/api/v1/me/avatar" alt="" /> : <p className="muted">{t(locale, "settings.noPhoto")}</p>}
        <input name="avatar" type="file" accept="image/jpeg,image/png,image/webp" />
        <button className="btn secondary" type="submit">{t(locale, "common.upload")}</button>
        {avatarError ? <p className="error" role="alert">{avatarError}</p> : null}
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
          {t(locale, "login.email")}
          <input value={me?.user?.email || ""} readOnly />
        </label>
        <p className="muted">{t(locale, "settings.emailHint")}</p>
        <label>
          {t(locale, "settings.jobTitle")}
          <input value={me?.activeTenant?.jobTitle || (["owner", "director", "sales_lead", "manager"].includes(me?.activeTenant?.role) ? t(locale, `settings.currentRole.${me.activeTenant.role}`) : me?.activeTenant?.roleLabel || "")} readOnly />
        </label>
        <p className="muted">{t(locale, "settings.jobTitleHint")}</p>
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
      setStatus(t(locale, "settings.passwordChanged"));
      event.currentTarget.reset();
      await loadSessions();
    } catch (err: any) {
      setErrors(Object.fromEntries(Object.entries(err?.body?.field_errors || {}).map(([key, value]) => [key, accountErrorMessage(locale, String(value))])));
      setStatus(accountErrorMessage(locale, err instanceof Error ? err.message : undefined));
    }
  }

  return (
    <>
      <form className="panel" onSubmit={onPassword}>
        <b>{t(locale, "settings.passwordChange")}</b>
        <label>
          {t(locale, "settings.currentPassword")}
          <PasswordInput name="currentPassword" autoComplete="current-password" required />
          <FieldError message={errors.currentPassword} />
        </label>
        <label>
          {t(locale, "login.resetNewPassword")}
          <PasswordInput name="newPassword" autoComplete="new-password" required />
        </label>
        <label>
          {t(locale, "login.passwordRepeat")}
          <PasswordInput name="confirmPassword" autoComplete="new-password" required />
          <FieldError message={errors.confirmPassword} />
        </label>
        {status ? <p>{status}</p> : null}
        <button className="btn" type="submit">{t(locale, "settings.changePassword")}</button>
      </form>
      <div className="panel">
        <div className="page-head">
          <b>{t(locale, "settings.sessions")}</b>
          <button
            type="button"
            className="btn secondary"
            onClick={() => void api.revokeOtherSessions().then(loadSessions)}
          >
            {t(locale, "settings.revokeOthers")}
          </button>
        </div>
        {sessions.map((item) => (
          <div className="row" key={item.id}>
            <div>
              <b>
                {item.title}
                {item.current ? ` · ${t(locale, "settings.currentSession")}` : ""}
              </b>
              <div className="muted">
                {item.lastSeenAt
                  ? t(locale, "settings.lastActive").replace("{date}", formatDateTime(item.lastSeenAt, { timeZone: me?.user?.timezone, timeFormat: me?.user?.timeFormat, locale }))
                  : t(locale, "settings.lastActiveUnknown")}
                {item.ip ? ` · ${item.ip}` : ""}
              </div>
            </div>
            {!item.current ? (
              <button type="button" className="btn secondary" onClick={() => void api.revokeSession(item.id).then(loadSessions)}>
                {t(locale, "settings.endSession")}
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
    ["new_inquiries", t(locale, "settings.notice.new_inquiries")],
    ["assignment", t(locale, "settings.notice.assignment")],
    ["dialogs", t(locale, "settings.notice.dialogs")],
    ["tasks", t(locale, "settings.notice.tasks")],
    ["deals", t(locale, "settings.notice.deals")],
    ["ai_events", t(locale, "settings.notice.ai_events")],
    ...(!caps.manager ? [["management", t(locale, "settings.notice.management")] as [string, string]] : []),
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
        <b>{t(locale, "settings.categories")}</b>
        {events.map(([key, label]) => (
          <label key={key} className="check-row">
            <input type="checkbox" name={`event_${key}`} defaultChecked={prefs.events?.[key] !== false} />
            {label}
          </label>
        ))}
        <b>{t(locale, "settings.channels")}</b>
        <label className="check-row">
          <input type="checkbox" name="ch_in_app" defaultChecked={prefs.channels?.in_app !== false} />
          {t(locale, "settings.inApp")}
        </label>
        <label className="check-row">
          <input type="checkbox" name="ch_web_push" defaultChecked={prefs.channels?.web_push !== false} />
          {t(locale, "settings.browserNotices")}
        </label>
        <p className="muted">{t(locale, "settings.noticeChannelsHint")}</p>
        <b>{t(locale, "settings.quietHours")}</b>
        <label className="check-row">
          <input type="checkbox" name="quiet" defaultChecked={Boolean(prefs.quietHours?.enabled)} />
          {t(locale, "common.enable")}
        </label>
        <label>
          {t(locale, "settings.quietStart")}
          <input name="quietStart" type="time" defaultValue={prefs.quietHours?.start || "22:00"} />
        </label>
        <label>
          {t(locale, "settings.quietEnd")}
          <input name="quietEnd" type="time" defaultValue={prefs.quietHours?.end || "08:00"} />
        </label>
        {status ? <p className="ok">{status}</p> : null}
        <button className="btn">{t(locale, "settings.save")}</button>
      </form>

      <div className="panel">
        <b>{t(locale, "settings.browserNotices")}</b>
        <p>
          {t(locale, "common.status")}: <b>{t(locale, `settings.permission.${permission}`)}</b>
          {enabled ? ` · ${t(locale, "settings.noticeEnabled")}` : ` · ${t(locale, "settings.noticeDisabled")}`}
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
            {t(locale, "settings.allowNotices")}
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
            {enabled ? t(locale, "settings.disableNotices") : t(locale, "settings.enableNotices")}
          </button>
        </div>
      </div>

      <div className="panel">
        <b>{t(locale, "settings.recentNotices")}</b>
        {notices.slice(0, 20).map((item) => (
          <div className="row" key={item.id}>
            <div>
              <b>{uiMessage(item.title, locale)}</b>
              <div className="muted">{uiNotificationBody(item.type, item.body, locale)}</div>
            </div>
            <Link className="btn secondary" to={item.href || "/today"}>
              {t(locale, "common.open")}
            </Link>
          </div>
        ))}
      </div>
    </>
  );
}

function InterfaceSection({ locale }: { locale: Locale }) {
  const uiText = useUiText();
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
          <option value="ru">{uiText("Русский")}</option>
          <option value="kk">{uiText("Қазақша")}</option>
          <option value="en">English</option>
        </select>
      </label>
      <label>
        {t(locale, "settings.timezone")}
        <input name="timezone" defaultValue={me?.user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone} />
      </label>
      <p className="muted">{t(locale, "settings.timezoneHint")}</p>
      <label>
        {t(locale, "settings.timeFormat")}
        <select name="timeFormat" defaultValue={me?.user?.timeFormat || "24"}>
          <option value="24">{t(locale, "settings.hours24")}</option>
          <option value="12">{t(locale, "settings.hours12")}</option>
        </select>
      </label>
      <label>
        {t(locale, "settings.theme")}
        <select name="theme" defaultValue={me?.user?.theme || "system"}>
          <option value="light">{t(locale, "settings.themeLight")}</option>
          <option value="dark">{t(locale, "settings.themeDark")}</option>
          <option value="system">{t(locale, "settings.themeSystem")}</option>
        </select>
      </label>
      {status ? <p className="ok">{status}</p> : null}
      <button className="btn">{t(locale, "settings.save")}</button>
    </form>
  );
}

const memberRoles = [
  ["owner", "Администратор компании"], ["director", "Директор"],
  ["sales_lead", "Руководитель продаж"], ["manager", "Менеджер"],
];
type MemberCapacity = { active: number; pending: number; limit: number | null; remaining: number | null; canInvite: boolean; entitled: boolean; planName: string };

function MembersSection({ locale }: { locale: Locale }) {
  const uiText = useUiText();
  const [items, setItems] = useState<any[]>([]);
  const [invitations, setInvitations] = useState<any[]>([]);
  const [capacity, setCapacity] = useState<MemberCapacity | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState<{ email: string; inviteUrl: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    const data = (await api.companyMembers()) as { items: any[]; invitations: any[]; capacity: MemberCapacity };
    setItems(data.items || []);
    setInvitations(data.invitations || []);
    setCapacity(data.capacity);
  }
  useEffect(() => { void load().catch((err) => setError(err instanceof Error ? err.message : uiText("Не удалось загрузить сотрудников"))); }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : uiText("Не удалось сохранить изменения")); }
    finally { setBusy(false); }
  }
  function showLink(value: any) { setLink(value); setCopied(false); }

  return (
    <div className="panel members-panel">
      <div className="members-heading">
        <div><h2>{t(locale, "settings.members")}</h2><p className="muted">{uiText("Управляйте доступом команды к вашей компании.")}</p></div>
        <button className="btn" disabled={busy || !capacity?.canInvite} onClick={() => setAdding(true)}>{uiText("Добавить сотрудника")}</button>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {capacity ? <div className="members-capacity">
        <div><b>{capacity.planName}</b><p>{uiText("Сотрудников:")}{" "}<strong>{capacity.active}{capacity.limit === null ? uiText(" · без ограничения") : ` / ${capacity.limit}`}</strong></p></div>
        <div><b>{capacity.remaining === null ? uiText("Места доступны") : uiText("Свободных мест: {p0}", {p0: capacity.remaining})}</b><p className="muted">{uiText("Ожидают приглашения:")}{" "}{capacity.pending}{uiText(". Они также занимают места.")}</p></div>
        {!capacity.canInvite ? <div className="members-limit"><p>{capacity.entitled ? uiText("Все места заняты. Отмените ненужное приглашение или подключите дополнительные места.") : uiText("Для добавления сотрудников выберите тариф с командной работой.")}</p><Link to="/billing">{uiText("Тарифы и дополнительные места →")}</Link></div> : null}
      </div> : !error ? <p className="muted" role="status">{uiText("Загружаем сотрудников и доступные места…")}</p> : null}
      {adding && capacity?.canInvite ? <form className="member-invite-form" onSubmit={event => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        void run(async () => {
          const result = await api.inviteCompanyMember({ name: String(form.get("name")), email: String(form.get("email")), role: String(form.get("role")) });
          showLink(result); setAdding(false);
        });
      }}>
        <h3>{uiText("Пригласить сотрудника")}</h3>
        <p className="muted">{uiText("Создайте ссылку и передайте её сотруднику. При первом входе он сам задаст пароль. Письмо автоматически не отправляется.")}</p>
        <div className="member-fields">
          <label>{uiText("Имя сотрудника")}<input name="name" required maxLength={160} autoComplete="off" placeholder={uiText("Имя и фамилия")} /></label>
          <label>{uiText("Электронная почта")}<input name="email" type="email" required maxLength={254} autoComplete="off" placeholder="name@company.kz" /></label>
          <label>{uiText("Роль")}<select name="role" defaultValue="manager">{localizeUiOptions(memberRoles, uiText).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        <div className="member-actions"><button className="btn" disabled={busy}>{busy ? uiText("Создаём приглашение…") : uiText("Создать приглашение")}</button><button type="button" className="btn secondary" disabled={busy} onClick={() => setAdding(false)}>{uiText("Отмена")}</button></div>
      </form> : null}
      {link ? <div className="member-invite-link" role="status">
        <b>{uiText("Приглашение для")}{" "}{link.email} {" "}{uiText("готово")}</b>
        <p>{uiText("Передайте ссылку лично сотруднику. Она действует до")}{" "}{formatDateTime(link.expiresAt, { locale })}.</p>
        <div className="member-link-controls"><input aria-label={uiText("Ссылка приглашения")} readOnly value={link.inviteUrl} onFocus={e => e.currentTarget.select()} /><button className="btn secondary" onClick={async () => {
          try { await navigator.clipboard.writeText(link.inviteUrl); setCopied(true); }
          catch { setError(uiText("Не удалось скопировать автоматически. Выделите ссылку и скопируйте её вручную.")); }
        }}>{copied ? uiText("Скопировано") : uiText("Скопировать ссылку")}</button></div>
      </div> : null}
      {items.map(item => <form key={item.id} className="member-card" onSubmit={event => {
        event.preventDefault(); const form = new FormData(event.currentTarget);
        void run(async () => { await api.updateCompanyMember(item.id, { role: form.get("role"), jobTitle: form.get("jobTitle") }); notifySaved(uiText("Сотрудник обновлён")); });
      }}>
        <div className="member-info"><b>{item.name}{item.isMe ? uiText(" (вы)") : ""}</b><div className="muted">{item.email}</div>{!item.active ? <span className="muted">{uiText("Доступ приостановлен")}</span> : null}</div>
        <div className="member-fields">
          <label>{uiText("Должность")}<input name="jobTitle" defaultValue={item.jobTitle || ""} placeholder={uiText("Укажите должность")} /></label>
          <label>{uiText("Роль")}<select name="role" defaultValue={item.role}>{localizeUiOptions(memberRoles, uiText).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        <button className="btn secondary" disabled={busy}>{t(locale, "settings.save")}</button>
      </form>)}
      {invitations.length ? <section className="member-invitations"><h3>{uiText("Приглашения")}</h3><p className="muted">{uiText("После обновления ссылки прежняя перестанет действовать.")}</p>
        {invitations.map(item => <div className="member-card" key={item.id}>
          <div className="member-info"><b>{item.name || item.email}</b><div className="muted">{item.email} · {localizeUiOptions(memberRoles, uiText).find(([role]) => role === item.role)?.[1] || uiText("Сотрудник")}</div><div className="muted">{new Date(item.expiresAt).getTime() > Date.now() ? uiText("Ожидает принятия · до ") : uiText("Срок истёк · ")}{formatDateTime(item.expiresAt, { locale })}</div></div>
          <div className="member-actions"><button className="btn secondary" disabled={busy || !capacity?.entitled || (new Date(item.expiresAt).getTime() <= Date.now() && !capacity?.canInvite)} onClick={() => void run(async () => showLink(await api.renewCompanyInvitation(item.id)))}>{uiText("Обновить ссылку")}</button><button className="btn secondary" disabled={busy} onClick={() => void run(async () => { await api.revokeCompanyInvitation(item.id); if (link?.email === item.email) setLink(null); })}>{uiText("Отменить приглашение")}</button></div>
        </div>)}
      </section> : null}
    </div>
  );
}

function OpsSection({ locale }: { locale: Locale }) {
  const uiText = useUiText();
  const [ops, setOps] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lostText, setLostText] = useState("");
  const [plan, setPlan] = useState("");

  async function load() {
    const data: any = await api.workspaceOps();
    setOps(data);
    setLostText((data.lostReasons || []).join("\n"));
    setPlan(data.salesPlanMinor != null ? String(data.salesPlanMinor) : "");
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : uiText("Ошибка")));
  }, []);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const stageSlaDays: Record<string, number> = {};
      for (const stage of ops?.stages || []) {
        const value = Number(stage.slaDays);
        if (Number.isFinite(value) && value > 0) stageSlaDays[stage.systemKey] = value;
      }
      const planNumber = plan.trim() ? Math.round(Number(plan.replace(/\s+/g, "").replace(",", "."))) : null;
      await api.updateWorkspaceOps({
        stalledDealDays: Number(ops.stalledDealDays),
        proposalFollowUpThresholdDays: Number(ops.proposalFollowUpThresholdDays),
        silenceReturnDays: Number(ops.silenceReturnDays),
        salesPlanMinor: planNumber,
        lostReasons: lostText.split("\n").map((line) => line.trim()).filter(Boolean),
        stageSlaDays,
      });
      notifySaved(uiText("Операционные настройки сохранены"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не сохранено"));
    } finally {
      setBusy(false);
    }
  }

  if (!ops) return <p className="muted">{t(locale, "common.loading")}</p>;

  return (
    <div className="panel">
      <b>{t(locale, "settings.ops")}</b>
      <p className="muted">{uiText("SLA этапов, причины потери и план продаж. Эти же значения использует «Ситуация».")}</p>
      {error ? <p className="error">{error}</p> : null}
      <label>
        {uiText("Дней без движения, чтобы сделка считалась зависшей")}<input
          type="number"
          min={1}
          max={90}
          value={ops.stalledDealDays}
          onChange={(e) => setOps({ ...ops, stalledDealDays: Number(e.target.value) })}
        />
      </label>
      <label>
        {uiText("Дней после КП без ответа")}<input
          type="number"
          min={1}
          max={90}
          value={ops.proposalFollowUpThresholdDays}
          onChange={(e) => setOps({ ...ops, proposalFollowUpThresholdDays: Number(e.target.value) })}
        />
      </label>
      <label>
        {uiText("Дней тишины по клиенту")}<input
          type="number"
          min={1}
          max={180}
          value={ops.silenceReturnDays}
          onChange={(e) => setOps({ ...ops, silenceReturnDays: Number(e.target.value) })}
        />
      </label>
      <label>
        {uiText("План продаж за период, ₸")}<input value={plan} onChange={(e) => setPlan(e.target.value)} placeholder={uiText("например 10000000")} />
      </label>
      <b>{uiText("SLA по этапам, дни")}</b>
      {(ops.stages || []).map((stage: any, index: number) => (
        <label key={stage.systemKey}>
          {stage.name}
          <input
            type="number"
            min={1}
            max={90}
            value={stage.slaDays ?? ""}
            onChange={(e) => {
              const next = [...(ops.stages || [])];
              next[index] = { ...stage, slaDays: e.target.value === "" ? null : Number(e.target.value) };
              setOps({ ...ops, stages: next });
            }}
          />
        </label>
      ))}
      <label>
        {uiText("Причины потери — по одной на строку")}<textarea rows={8} value={lostText} onChange={(e) => setLostText(e.target.value)} />
      </label>
      <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
        {t(locale, "settings.save")}
      </button>
    </div>
  );
}

function AuditSection({ locale }: { locale: Locale }) {
  const uiText = useUiText();
  const { me } = useSession();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  async function load(nextPage = page, query = q) {
    try {
      const result = await api.workspaceAudit({ page: nextPage, q: query || undefined, limit: 40 });
      setData(result);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Ошибка"));
    }
  }

  useEffect(() => {
    void load(1, "");
  }, []);

  return (
    <div className="panel">
      <b>{t(locale, "settings.audit")}</b>
      <p className="muted">{uiText("Кто что изменил в этой компании. Журнал доступен администратору и директору.")}</p>
      {error ? <p className="error">{error}</p> : null}
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          void load(1, q);
        }}
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={uiText("сделка, клиент, настройки…")} />
        <button className="btn secondary">{uiText("Найти")}</button>
      </form>
      {(data?.items || []).map((item: any) => (
        <div className="row" key={item.id} style={{ alignItems: "flex-start" }}>
          <div>
            <b>{uiMessage(item.actionLabel) || uiText("Действие в системе")}</b>
            <div className="muted">
              {uiMessage(item.actorLabel)}
              {uiMessage(item.entityLabel) ? ` · ${uiMessage(item.entityLabel)}` : ""}
              {" · "}
              {formatDateTime(item.createdAt, { timeZone: me?.user?.timezone, locale })}
            </div>
            {item.details?.length ? <ul className="audit-details">{item.details.map((detail: string, index: number) => <li key={index}>{detail}</li>)}</ul> : null}
          </div>
        </div>
      ))}
      {data && data.total > data.pageSize ? (
        <div className="actions">
          <button
            type="button"
            className="btn secondary"
            disabled={page <= 1}
            onClick={() => {
              const next = page - 1;
              setPage(next);
              void load(next);
            }}
          >
            {uiText("Назад")}</button>
          <button
            type="button"
            className="btn secondary"
            disabled={page * data.pageSize >= data.total}
            onClick={() => {
              const next = page + 1;
              setPage(next);
              void load(next);
            }}
          >
            {uiText("Дальше")}</button>
        </div>
      ) : null}
    </div>
  );
}

type ControlUser = {
  userId: string;
  name: string;
  email: string;
  role: string;
  enabled: boolean;
  status: string;
  canReadFinancialData: boolean;
  canReadTeamData: boolean;
  canCreateTasks: boolean;
  canModifyDeals: boolean;
  canPerformBulkActions: boolean;
  requiresConfirmationForWrites: boolean;
  lastActivityAt: string | null;
  identities: Array<{
    id: string;
    provider: string;
    externalUserId: string;
    phoneNormalized: string | null;
    verified: boolean;
    verifiedAt: string | null;
    enabled: boolean;
  }>;
};

function ControlSection({ locale }: { locale: Locale }) {
  const uiText = useUiText();
  const { me } = useSession();
  const [data, setData] = useState<{ enabled: boolean; users: ControlUser[] } | null>(null);
  const [history, setHistory] = useState<any>(null);
  const [error, setError] = useState("");
  const [phoneByUser, setPhoneByUser] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState({ action: "", source: "", status: "" });

  async function load() {
    try {
      const [settings, hist] = await Promise.all([
        api.controlSettings(),
        api.controlHistory({ limit: 30 }),
      ]);
      setData(settings as { enabled: boolean; users: ControlUser[] });
      setHistory(hist);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Ошибка"));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggleCompany(enabled: boolean) {
    await api.updateControlSettings({ enabled });
    notifySaved(enabled ? uiText("BasQar Control включён") : uiText("BasQar Control выключен"));
    await load();
  }

  async function toggleUser(user: ControlUser, enabled: boolean) {
    await api.upsertControlAccess(user.userId, { enabled });
    notifySaved(enabled ? uiText("{p0}: доступ включён", {p0: user.name}) : uiText("{p0}: доступ выключен", {p0: user.name}));
    await load();
  }

  async function saveFlags(user: ControlUser, patch: Record<string, boolean>) {
    await api.upsertControlAccess(user.userId, patch);
    notifySaved(uiText("Разрешения сохранены"));
    await load();
  }

  async function linkPhone(user: ControlUser) {
    const phone = phoneByUser[user.userId];
    if (!phone) return;
    const result = (await api.createControlIdentity({
      userId: user.userId,
      provider: "WHATSAPP",
      phone,
    })) as { verificationCode?: string | null };
    if (result.verificationCode) {
      notifySaved(uiText("Код подтверждения: {p0}", {p0: result.verificationCode}));
    } else {
      notifySaved(uiText("Номер привязан"));
    }
    await load();
  }

  async function applyHistory() {
    const hist = await api.controlHistory({
      limit: 30,
      action: filters.action || undefined,
      source: filters.source || undefined,
      status: filters.status || undefined,
    });
    setHistory(hist);
  }

  if (!data) {
    return (
      <div className="panel">
        <b>{t(locale, "settings.control")}</b>
        {error ? <p className="error">{error}</p> : <p className="muted">{t(locale, "common.loading")}</p>}
      </div>
    );
  }

  return (
    <>
      <div className="panel">
        <b>{t(locale, "settings.control")}</b>
        <p className="muted">
          {uiText("Внешний AI (WhatsApp и другие каналы) получает данные и выполняет команды только через CRM, от имени конкретного сотрудника и с его правами. Совпадение номера само по себе не является входом.")}</p>
        {error ? <p className="error">{error}</p> : null}
        <label className="row" style={{ alignItems: "center", gap: 8 }}>
          <input type="checkbox" checked={data.enabled} onChange={(e) => void toggleCompany(e.target.checked)} />
          {uiText("BasQar Control включён для компании")}</label>
      </div>
      {data.users.map((user) => (
        <div className="panel" key={user.userId}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <b>{user.name}</b>
              <div className="muted">
                {user.email} · {user.role}
                {user.lastActivityAt
                  ? uiText(" · последняя активность {p0}", {p0: formatDateTime(user.lastActivityAt, { timeZone: me?.user?.timezone, locale })})
                  : ""}
              </div>
            </div>
            <button type="button" className="btn secondary" onClick={() => void toggleUser(user, !user.enabled)}>
              {user.enabled ? uiText("Отключить доступ") : uiText("Включить доступ")}
            </button>
          </div>
          <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
            {(
              [
                ["canReadFinancialData", uiText("Финансы")],
                ["canReadTeamData", uiText("Команда")],
                ["canCreateTasks", uiText("Задачи")],
                ["canModifyDeals", uiText("Сделки")],
                ["canPerformBulkActions", uiText("Массовые действия")],
                ["requiresConfirmationForWrites", uiText("Подтверждать записи")],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="muted">
                <input
                  type="checkbox"
                  checked={Boolean(user[key])}
                  onChange={(e) => void saveFlags(user, { [key]: e.target.checked })}
                />{" "}
                {label}
              </label>
            ))}
          </div>
          {(user.identities || []).map((ident) => (
            <div className="row" key={ident.id} style={{ justifyContent: "space-between" }}>
              <div>
                <b>
                  {ident.provider} · {ident.phoneNormalized || ident.externalUserId}
                </b>
                <div className="muted">
                  {ident.verified ? uiText("подтверждён") : uiText("ожидает подтверждения")}
                  {ident.enabled ? "" : uiText(" · отключён")}
                </div>
              </div>
              <div className="actions">
                {!ident.verified ? (
                  <button type="button" className="btn secondary" onClick={() => void api.verifyControlIdentity(ident.id).then(load)}>
                    {uiText("Подтвердить в CRM")}</button>
                ) : null}
                {ident.enabled ? (
                  <button type="button" className="btn secondary" onClick={() => void api.disableControlIdentity(ident.id).then(load)}>
                    {uiText("Отключить канал")}</button>
                ) : null}
              </div>
            </div>
          ))}
          <form
            className="row"
            onSubmit={(event) => {
              event.preventDefault();
              void linkPhone(user);
            }}
          >
            <input
              placeholder={uiText("WhatsApp номер, +7…")}
              value={phoneByUser[user.userId] || ""}
              onChange={(e) => setPhoneByUser((prev) => ({ ...prev, [user.userId]: e.target.value }))}
            />
            <button className="btn secondary" type="submit">
              {uiText("Привязать WhatsApp")}</button>
          </form>
        </div>
      ))}
      <div className="panel">
        <b>{uiText("История команд")}</b>
        <form
          className="row"
          onSubmit={(event) => {
            event.preventDefault();
            void applyHistory();
          }}
        >
          <input
            placeholder={uiText("действие, GET_LEADS_STATS")}
            value={filters.action}
            onChange={(e) => setFilters({ ...filters, action: e.target.value })}
          />
          <input
            placeholder={uiText("источник, WHATSAPP")}
            value={filters.source}
            onChange={(e) => setFilters({ ...filters, source: e.target.value })}
          />
          <input
            placeholder={uiText("статус, OK")}
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          />
          <button className="btn secondary">{uiText("Найти")}</button>
        </form>
        {(history?.items || []).map((item: any) => (
          <div className="row" key={item.id}>
            <div>
              <b>{item.action}</b>
              <div className="muted">
                {item.actor?.name || item.actor?.email || uiText("сотрудник")}
                {item.source ? ` · ${item.source}` : ""}
                {item.status ? ` · ${item.status}` : ""}
                {" · "}
                {formatDateTime(item.createdAt, { timeZone: me?.user?.timezone, locale })}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
