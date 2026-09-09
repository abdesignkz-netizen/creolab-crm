import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, setTenant } from "./lib/api";
import { NavIcon } from "./components/NavIcon";
import { tip } from "./lib/tip";
import {
  currentBrowserPermission,
  dismissNotificationBanner,
  getBrowserNotificationPreference,
  isLikelyIosSafari,
  isNotificationBannerDismissed,
  isStandaloneDisplayMode,
  requestBrowserNotificationPermission,
  setBrowserNotificationPreference,
  showBrowserNotification,
  startNotificationPolling,
} from "./lib/browserNotifications";
const ClientsPage = lazy(() => import("./pages/ClientsPage").then(m => ({ default: m.ClientsPage })));
const CompaniesPage = lazy(() => import("./pages/CompaniesPage").then(m => ({ default: m.CompaniesPage })));
const CompanyPage = lazy(() => import("./pages/CompanyPage").then(m => ({ default: m.CompanyPage })));
const ContactPage = lazy(() => import("./pages/ContactPage").then(m => ({ default: m.ContactPage })));
const ControlPage = lazy(() => import("./pages/ControlPage").then(m => ({ default: m.ControlPage })));
const ConversationsPage = lazy(() => import("./pages/ConversationsPage").then(m => ({ default: m.ConversationsPage })));
const DealsPage = lazy(() => import("./pages/DealsPage").then(m => ({ default: m.DealsPage })));
const DealDetailPage = lazy(() => import("./pages/DealsPage").then(m => ({ default: m.DealDetailPage })));
const IntegrationsPage = lazy(() => import("./pages/IntegrationsPage").then(m => ({ default: m.IntegrationsPage })));
const RequestDetailPage = lazy(() => import("./pages/RequestDetailPage").then(m => ({ default: m.RequestDetailPage })));
const RequestsPage = lazy(() => import("./pages/RequestsPage").then(m => ({ default: m.RequestsPage })));
const AiAutomationSettingsPage = lazy(() => import("./pages/AiAutomationSettingsPage").then(m => ({ default: m.AiAutomationSettingsPage })));
const SituationPage = lazy(() => import("./pages/SituationPage").then(m => ({ default: m.SituationPage })));
const StatsPage = lazy(() => import("./pages/StatsPage").then(m => ({ default: m.StatsPage })));
const TasksPage = lazy(() => import("./pages/TasksPage").then(m => ({ default: m.TasksPage })));

type LoadState<T> = { status: "loading" | "ready" | "error" | "empty"; data?: T; error?: string };

function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fn()
      .then((data) => {
        if (cancelled) return;
        const empty = Array.isArray((data as { items?: unknown[] }).items)
          ? !(data as { items: unknown[] }).items.length
          : !data;
        setState({ status: empty ? "empty" : "ready", data });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: "error", error: error.message });
      });
    return () => {
      cancelled = true;
    };
  }, [...deps, revision]);
  return [state, () => setRevision((value) => value + 1)] as const;
}

function StateView({ state, onRetry, empty }: { state: LoadState<unknown>; onRetry: () => void; empty: string }) {
  if (state.status === "loading") return <div className="state">Загрузка…</div>;
  if (state.status === "error") {
    return (
      <div className="state">
        <p className="error">{state.error}</p>
        <button className="btn" onClick={onRetry}>Повторить</button>
      </div>
    );
  }
  if (state.status === "empty") return <div className="empty">{empty}</div>;
  return null;
}

function Shell({ me, children }: { me: any; children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const tenantId = me.activeTenant?.tenant?.id;
  const [unreadNotices, setUnreadNotices] = useState(0);
  const [navBadges, setNavBadges] = useState<Record<string, number>>({});
  const [navHints, setNavHints] = useState<Record<string, string>>({});
  const [navHrefs, setNavHrefs] = useState<Record<string, string>>({});
  const [notifyBanner, setNotifyBanner] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreSheetRef = useRef<HTMLDivElement>(null);

  const primaryTabs = [
    { to: "/today", label: "Главная", icon: "home" },
    { to: "/conversations", label: "Диалоги", icon: "chat" },
    { to: "/tasks", label: "Задачи", icon: "tasks" },
    { to: "/inquiries", label: "Заявки", icon: "inquiries" },
  ] as const;

  const moreLinks = [
    ["/control", "Управление"],
    ["/contacts", "Клиенты"],
    ["/companies", "Компании"],
    ["/deals", "Сделки"],
    ["/integrations", "Интеграции"],
    ["/stats", "Статистика"],
    ["/settings", "Настройки"],
  ] as const;

  const workLinks = [
    ["/today", "Главная"],
    ["/conversations", "Диалоги"],
    ["/tasks", "Задачи"],
    ["/contacts", "Клиенты"],
    ["/companies", "Компании"],
    ["/inquiries", "Заявки"],
    ["/deals", "Сделки"],
  ] as const;
  const systemLinks = [
    ["/control", "Управление"],
    ["/integrations", "Интеграции"],
    ["/stats", "Статистика"],
    ["/settings", "Настройки"],
  ] as const;

  function badgeCount(path: string) {
    const n = Number(navBadges[path] || 0);
    return n > 0 ? n : 0;
  }

  function badgeHint(path: string, fallback = "Требует внимания") {
    return navHints[path] || fallback;
  }

  function navTo(path: string) {
    if (badgeCount(path) > 0) {
      return navHrefs[path] || (
        path === "/contacts" ? "/contacts?filter=new"
        : path === "/conversations" ? "/conversations?filter=attention"
        : path === "/tasks" ? "/tasks?filter=overdue"
        : path === "/inquiries" ? "/inquiries?filter=attention"
        : path
      );
    }
    return path;
  }

  function onNavClick(path: string, event: MouseEvent<HTMLAnchorElement>) {
    const href = navTo(path);
    const queryAt = href.indexOf("?");
    const pathname = queryAt === -1 ? href : href.slice(0, queryAt);
    const search = queryAt === -1 ? "" : href.slice(queryAt);
    if (location.pathname === pathname && location.search !== search) {
      event.preventDefault();
      navigate(href);
    }
  }

  function formatBadge(n: number) {
    return n > 9 ? "9+" : String(n);
  }

  const moreBadgeTotal = moreLinks.reduce((sum, [path]) => sum + badgeCount(path), 0);

  const titleMap: Record<string, string> = {
    "/today": "Главная",
    "/control": "Управление",
    "/inquiries": "Заявки",
    "/requests": "Заявка",
    "/conversations": "Диалоги",
    "/deals": "Сделки",
    "/tasks": "Задачи",
    "/contacts": "Клиенты",
    "/companies": "Компании",
    "/integrations": "Интеграции",
    "/stats": "Статистика",
    "/settings": "Настройки",
    "/admin": "Платформа",
  };
  const pageTitle =
    Object.entries(titleMap).find(([path]) => location.pathname === path || location.pathname.startsWith(`${path}/`))?.[1] ||
    "CREOLAB CRM";
  const inquiriesActive = location.pathname === "/inquiries" || location.pathname.startsWith("/requests/");
  const moreActive = moreLinks.some(([path]) => location.pathname === path || location.pathname.startsWith(`${path}/`));

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    async function syncQuietly() {
      try {
        await api.syncWhatsApp();
      } catch {
        // бот не подключён / недоступен — тихий пропуск
      }
    }
    void syncQuietly();
    const timer = window.setInterval(() => {
      if (!cancelled) void syncQuietly();
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tenantId]);

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    async function loadBadges() {
      try {
        const data = (await api.navBadges()) as {
          badges?: Record<string, number>;
          hints?: Record<string, string>;
          hrefs?: Record<string, string>;
        };
        if (cancelled) return;
        const badges = data.badges || {};
        setNavBadges(badges);
        setNavHints(data.hints || {});
        setNavHrefs(data.hrefs || {});
        setUnreadNotices(Number(badges["/settings"] || 0));
      } catch {
        // silently keep previous badges
      }
    }
    void loadBadges();
    const timer = window.setInterval(() => {
      if (!cancelled) void loadBadges();
    }, 30_000);
    const onAttention = () => {
      if (!cancelled) void loadBadges();
    };
    window.addEventListener("creolab:attention-changed", onAttention);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("creolab:attention-changed", onAttention);
    };
  }, [tenantId, location.pathname]);

  useEffect(() => {
    if (!tenantId) return;
    const permission = currentBrowserPermission();
    const wantsNotifications = getBrowserNotificationPreference();
    const dismissed = isNotificationBannerDismissed();
    if (permission === "granted" && wantsNotifications) {
      setNotifyBanner(false);
    } else if (permission === "default" && !dismissed) {
      setNotifyBanner(true);
    } else if (permission === "unsupported" && isLikelyIosSafari() && !isStandaloneDisplayMode() && !dismissed) {
      setNotifyBanner(true);
    } else if (permission === "denied" && !dismissed) {
      setNotifyBanner(true);
    }
    const stop = startNotificationPolling({
      tenantId,
      intervalMs: 20_000,
      load: async () => {
        const data = (await api.notifications()) as { items?: any[] } | any[];
        const items = Array.isArray(data) ? data : data.items || [];
        return items.map((item) => ({
          id: item.id,
          title: item.title,
          body: item.body,
          type: item.type,
          priority: item.priority,
          href: item.href || "/today",
          readAt: item.readAt,
          createdAt: item.createdAt,
        }));
      },
      onUnreadCount: (count) => {
        setUnreadNotices(count);
        setNavBadges((prev) => ({ ...prev, "/settings": count }));
      },
      onNavigate: (url) => navigate(url),
    });
    return stop;
  }, [tenantId, navigate]);

  useEffect(() => {
    if (!moreOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    moreSheetRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    return () => { document.body.style.overflow = previousOverflow; if (previous?.isConnected) previous.focus(); };
  }, [moreOpen]);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === "Escape") setMoreOpen(false); };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, []);

  useEffect(() => {
    setMoreOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth > 767) setMoreOpen(false);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  async function logout() {
    await api.request("/api/v1/auth/logout", { method: "POST", body: "{}" });
    navigate("/login");
  }

  return (
    <div className={`app-shell ${moreOpen ? "more-open" : ""}`}>
      <header className="mobile-topbar">
        <div className="mobile-topbar-title">
          <b>{pageTitle}</b>
          <span className="muted">{me.activeTenant?.tenant?.name || "Нет компании"}</span>
        </div>
        {unreadNotices > 0 ? (
          <button type="button" className="nav-badge" onClick={() => navigate("/settings")} title="Уведомления">
            {unreadNotices > 9 ? "9+" : unreadNotices}
          </button>
        ) : (
          <span className="nav-badge-spacer" />
        )}
      </header>

      <aside className="nav desktop-nav">
        <div className="nav-brand">
          <div className="brand-mark" aria-hidden>
            C
          </div>
          <div>
            <h1>CREOLAB</h1>
            <p>{me.activeTenant?.tenant?.name || "Нет компании"}</p>
          </div>
        </div>
        <nav className="nav-links">
          <p className="nav-section">Работа</p>
          {workLinks.map(([to, label]) => {
            const count = badgeCount(to);
            const hint = badgeHint(to);
            return (
              <NavLink
                key={to}
                to={navTo(to)}
                className={({ isActive }) => (isActive ? "active" : "")}
                aria-label={count > 0 ? `${label}. ${hint}` : label}
                onClick={(event) => onNavClick(to, event)}
              >
                <span className="nav-link-label"><NavIcon to={to} />{label}</span>
                {count > 0 ? (
                  <span className="nav-badge" {...tip(hint)}>
                    {formatBadge(count)}
                  </span>
                ) : null}
              </NavLink>
            );
          })}
          <p className="nav-section">Система</p>
          {systemLinks.map(([to, label]) => {
            const count = badgeCount(to);
            const hint = badgeHint(to, to === "/settings" ? "Непрочитанные уведомления" : "Требует внимания");
            return (
              <NavLink
                key={to}
                to={navTo(to)}
                className={({ isActive }) => (isActive ? "active" : "")}
                aria-label={count > 0 ? `${label}. ${hint}` : label}
                onClick={(event) => onNavClick(to, event)}
              >
                <span className="nav-link-label"><NavIcon to={to} />{label}</span>
                {count > 0 ? (
                  <span className="nav-badge" {...tip(hint)}>
                    {formatBadge(count)}
                  </span>
                ) : null}
              </NavLink>
            );
          })}
          {me.user.platformAdmin ? <NavLink to="/admin">Кабинет платформы</NavLink> : null}
        </nav>
        <button className="btn secondary nav-logout" onClick={logout} {...tip("Завершить сеанс в этом браузере")}>
          Выйти
        </button>
      </aside>

      <main className="main">
        <div className="workspace-toolbar">
          <div className="workspace-breadcrumb"><span>Рабочее пространство</span><span aria-hidden="true">/</span><span>{pageTitle}</span></div>
          <div className="workspace-identity"><span>{me.user.name}</span><span className="workspace-avatar" aria-hidden="true">{String(me.user.name || "C").split(" ").slice(0, 2).map((part) => part[0]).join("")}</span></div>
        </div>
        {notifyBanner ? (
          <div className="banner warn notify-banner">
            <div className="notify-banner-copy">
              <b>Уведомления</b>
              <span>
                {currentBrowserPermission() === "denied"
                  ? "Разрешение запрещено в браузере. Откройте настройки сайта и разрешите уведомления, затем нажмите «Включить»."
                  : isLikelyIosSafari() && !isStandaloneDisplayMode()
                    ? "На iPhone уведомления работают только с иконки: Поделиться → На экран «Домой», откройте CRM с иконки, затем Настройки → Разрешить."
                    : "Включите уведомления — новые заявки и важные события придут даже при свёрнутом окне."}
              </span>
            </div>
            <div className="actions">
              {isLikelyIosSafari() && !isStandaloneDisplayMode() ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    dismissNotificationBanner();
                    setNotifyBanner(false);
                    navigate("/settings");
                  }}
                >
                  Как включить
                </button>
              ) : (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void (async () => {
                      const result = await requestBrowserNotificationPermission();
                      if (result === "granted") {
                        setNotifyBanner(false);
                      }
                    })();
                  }}
                >
                  Включить
                </button>
              )}
              <button
                type="button"
                className="btn secondary"
                onClick={() => {
                  dismissNotificationBanner();
                  setNotifyBanner(false);
                }}
              >
                Позже
              </button>
            </div>
          </div>
        ) : null}
        {children}
      </main>

      {moreOpen ? <button type="button" className="nav-backdrop" aria-label="Закрыть" onClick={() => setMoreOpen(false)} /> : null}

      <div className={`more-sheet ${moreOpen ? "open" : ""}`} ref={moreSheetRef} role="dialog" aria-label="Ещё разделы" aria-modal={moreOpen || undefined} aria-hidden={!moreOpen} inert={!moreOpen} onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = moreSheetRef.current?.querySelectorAll<HTMLElement>("a, button");
        if (!controls?.length) return;
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
        <div className="more-sheet-handle" />
        <div className="more-sheet-heading"><b className="more-sheet-title">Ещё</b><button type="button" className="btn secondary" onClick={() => setMoreOpen(false)}>Закрыть</button></div>
        <nav className="more-sheet-links">
          {moreLinks.map(([to, label]) => {
            const count = badgeCount(to);
            const hint = badgeHint(to);
            return (
              <NavLink
                key={to}
                to={navTo(to)}
                className={({ isActive }) => (isActive ? "active" : "")}
                aria-label={count > 0 ? `${label}. ${hint}` : label}
                onClick={(event) => {
                  onNavClick(to, event);
                  setMoreOpen(false);
                }}
              >
                <span className="nav-link-label"><NavIcon to={to} />{label}</span>
                {count > 0 ? <span className="nav-badge" {...tip(hint)}>{formatBadge(count)}</span> : null}
              </NavLink>
            );
          })}
          {me.user.platformAdmin ? (
            <NavLink to="/admin" onClick={() => setMoreOpen(false)}>
              Кабинет платформы
            </NavLink>
          ) : null}
        </nav>
        <button type="button" className="btn secondary" onClick={logout} {...tip("Завершить сеанс в этом браузере")}>
          Выйти
        </button>
      </div>

      <nav className="mobile-tabbar" aria-label="Основная навигация">
        {primaryTabs.map((tab) => {
          const count = badgeCount(tab.to);
          const hint = badgeHint(tab.to);
          return (
            <NavLink
              key={tab.to}
              to={navTo(tab.to)}
              className={({ isActive }) => {
                const active = tab.to === "/inquiries" ? inquiriesActive : isActive;
                return active ? `tab active tab-${tab.icon}` : `tab tab-${tab.icon}`;
              }}
              aria-label={count > 0 ? `${tab.label}. ${hint}` : tab.label}
              onClick={(event) => onNavClick(tab.to, event)}
            >
              <span className="tab-icon-wrap">
                <span className={`tab-icon icon-${tab.icon}`} aria-hidden />
                {count > 0 ? <span className="tab-badge" {...tip(hint)}>{formatBadge(count)}</span> : null}
              </span>
              <span className="tab-label">{tab.label}</span>
            </NavLink>
          );
        })}
        <button
          type="button"
          className={`tab tab-more ${moreActive || moreOpen ? "active" : ""}`}
          aria-expanded={moreOpen}
          aria-haspopup="dialog"
          onClick={() => setMoreOpen((v) => !v)}
        >
          <span className="tab-icon-wrap">
            <span className="tab-icon icon-more" aria-hidden />
            {moreBadgeTotal > 0 ? <span className="tab-badge">{formatBadge(moreBadgeTotal)}</span> : null}
          </span>
          <span className="tab-label">Ещё</span>
        </button>
      </nav>
    </div>
  );
}

function Login() {
  const [error, setError] = useState("");
  return (
    <div className="login">
      <div className="login-stage">
        <div className="login-brand">
          <div className="brand-mark" aria-hidden>
            C
          </div>
          <h1 className="brand-wordmark">CREOLAB</h1>
          <p>CRM для продаж и диалогов — спокойный рабочий контур команды.</p>
        </div>
        <form
          className="panel"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            try {
              const result = (await api.login(String(form.get("email")), String(form.get("password")))) as any;
              const tenantId =
                result.user?.activeTenant?.tenant?.id || result.user?.memberships?.[0]?.tenant?.id;
              if (tenantId) setTenant(tenantId);
              // Полная перезагрузка: App заново вызовет /me с cookie и снимет boot=anon
              window.location.assign("/today");
            } catch (err) {
              const message = err instanceof Error ? err.message : "Ошибка входа";
              setError(
                message === "Failed to fetch" || message === "HTTP 500"
                  ? "Нет связи с API на порту 4100. Запустите npm run dev в папке CRM и откройте http://127.0.0.1:4180."
                  : message,
              );
            }
          }}
        >
          <h2>Вход</h2>
          <p className="muted">Email и пароль. WhatsApp для входа не нужен.</p>
          <label>
            Email
            <input name="email" type="email" required defaultValue="owner@creolab.example" autoComplete="username" />
          </label>
          <label>
            Пароль
            <input
              name="password"
              type="password"
              required
              defaultValue="ChangeMeLocal1!"
              autoComplete="current-password"
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <button className="btn">Войти</button>
        </form>
      </div>
    </div>
  );
}

function Today() {
  return <SituationPage />;
}

function SimpleList({ title, load, render }: { title: string; load: () => Promise<any>; render: (item: any) => ReactNode }) {
  const [state] = useQuery(load);
  if (state.status !== "ready" || !state.data) {
    return <StateView state={state} onRetry={() => location.reload()} empty="Пока пусто" />;
  }
  return (
    <section>
      <h2>{title}</h2>
      {state.data.items.map(render)}
    </section>
  );
}

function Settings() {
  const [state] = useQuery(() => api.knowledge() as Promise<any>);
  const [sandbox, setSandbox] = useState("");
  const [notices, setNotices] = useState<any[]>([]);
  const [permission, setPermission] = useState(currentBrowserPermission());
  const [enabled, setEnabled] = useState(getBrowserNotificationPreference());
  const [noticeError, setNoticeError] = useState("");
  const [notifyHint, setNotifyHint] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);
  const [permitBusy, setPermitBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);

  async function loadNotices() {
    try {
      const data = (await api.notifications()) as { items?: any[] } | any[];
      setNotices(Array.isArray(data) ? data : data.items || []);
      setNoticeError("");
    } catch (err) {
      setNoticeError(err instanceof Error ? err.message : "Не удалось загрузить уведомления");
    }
  }

  useEffect(() => {
    void loadNotices();
    setPermission(currentBrowserPermission());
    setEnabled(getBrowserNotificationPreference());
  }, []);

  if (state.status !== "ready") {
    return <StateView state={state} onRetry={() => location.reload()} empty="Нет настроек" />;
  }

  const iosNeedsHomeScreen = isLikelyIosSafari() && !isStandaloneDisplayMode();
  const canRequestPermission = permission === "default" || permission === "granted";
  const canTest = permission === "granted";

  const permissionLabel =
    permission === "granted"
      ? "разрешены"
      : permission === "denied"
        ? "запрещены в браузере"
        : iosNeedsHomeScreen
          ? "нужен экран «Домой» (сейчас открыто в Safari)"
          : permission === "unsupported"
            ? "не поддерживаются этим браузером"
            : "ещё не запрошены";

  function setFeedback(tone: "ok" | "warn" | "error", text: string) {
    setNotifyHint({ tone, text });
  }

  return (
    <section>
      <h2>Настройки компании</h2>
      <p>
        <a href="/integrations">Подключить WhatsApp, форму, webhook и Telegram →</a>
      </p>
      <p>
        <a href="/control">Управлять ИИ, диалогами и задачами →</a>
      </p>
      <p>
        <a href="/settings/ai-automation">AI Manager → Новые заявки →</a>
      </p>

      <div className="panel">
        <b>Уведомления браузера</b>
        <p className="muted">
          Новые заявки, обращения без телефона и диалоги, где нужен человек. Работают при свёрнутом окне CRM, пока
          браузер запущен.
        </p>

        {iosNeedsHomeScreen ? (
          <div className="notify-steps">
            <b>На iPhone уведомления работают только с иконки</b>
            <ol>
              <li>Нажмите кнопку «Поделиться» внизу Safari</li>
              <li>Выберите «На экран „Домой“» → «Добавить»</li>
              <li>Закройте эту вкладку и откройте CRM с новой иконки</li>
              <li>Внутри приложения нажмите «Разрешить уведомления»</li>
            </ol>
          </div>
        ) : null}

        <p>
          Статус: <b>{permissionLabel}</b>
          {enabled ? " · включены в кабинете" : " · выключены в кабинете"}
        </p>

        {notifyHint ? <div className={`notify-feedback ${notifyHint.tone}`}>{notifyHint.text}</div> : null}

        <div className="actions notify-actions">
          {iosNeedsHomeScreen ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setPermission(currentBrowserPermission());
                if (isStandaloneDisplayMode()) {
                  setFeedback("ok", "Открыто с иконки — теперь нажмите «Разрешить уведомления».");
                } else {
                  setFeedback(
                    "warn",
                    "Пока открыто во вкладке Safari. Добавьте на экран «Домой» и зайдите с иконки — иначе iPhone не даст уведомления.",
                  );
                }
              }}
            >
              Я открыл с иконки — проверить
            </button>
          ) : (
            <button
              type="button"
              className="btn"
              disabled={permitBusy || permission === "granted"}
              onClick={() => {
                setPermitBusy(true);
                setNotifyHint(null);
                void (async () => {
                  try {
                    const result = await requestBrowserNotificationPermission();
                    setPermission(result);
                    if (result === "granted") {
                      setEnabled(true);
                      setBrowserNotificationPreference(true);
                      setFeedback("ok", "Готово: уведомления разрешены. Можно нажать «Проверить».");
                      return;
                    }
                    if (result === "denied") {
                      setFeedback(
                        "error",
                        "Браузер запретил уведомления. В настройках сайта разрешите их и обновите страницу.",
                      );
                      return;
                    }
                    setFeedback(
                      "warn",
                      "Этот браузер не поддерживает уведомления. Откройте CRM в Chrome или Safari по HTTPS.",
                    );
                  } finally {
                    setPermitBusy(false);
                  }
                })();
              }}
            >
              {permitBusy ? "Запрашиваем…" : permission === "granted" ? "Уже разрешено ✓" : "Разрешить уведомления"}
            </button>
          )}

          <button
            type="button"
            className="btn secondary"
            onClick={() => {
              const next = !enabled;
              setBrowserNotificationPreference(next);
              setEnabled(next);
              setFeedback("ok", next ? "Включены в кабинете." : "Выключены в кабинете (тосты не приходят).");
            }}
          >
            {enabled ? "Выключить в кабинете" : "Включить в кабинете"}
          </button>

          <button
            type="button"
            className="btn secondary"
            disabled={testBusy}
            onClick={() => {
              if (!canTest) {
                setFeedback(
                  "warn",
                  iosNeedsHomeScreen
                    ? "Сначала откройте CRM с экрана «Домой», затем разрешите уведомления — после этого «Проверить» отправит тест."
                    : permission === "denied"
                      ? "Сначала разрешите уведомления в настройках сайта браузера."
                      : "Сначала нажмите «Разрешить уведомления» и согласитесь в диалоге браузера.",
                );
                return;
              }
              setTestBusy(true);
              setNotifyHint(null);
              void (async () => {
                try {
                  const ok = await showBrowserNotification({
                    title: "CREOLAB CRM",
                    body: "Тестовое уведомление. Так будут приходить новые заявки.",
                    tag: `test-${Date.now()}`,
                    url: "/settings",
                    force: true,
                  });
                  setFeedback(
                    ok ? "ok" : "error",
                    ok
                      ? "Тест отправлен. Если не видно — откройте Центр уведомлений или выключите «Не беспокоить»."
                      : "Не удалось показать уведомление. Нажмите «Разрешить уведомления» ещё раз.",
                  );
                } finally {
                  setTestBusy(false);
                }
              })();
            }}
          >
            {testBusy ? "Отправляем…" : "Проверить"}
          </button>
        </div>

        {!canTest && !iosNeedsHomeScreen && canRequestPermission ? (
          <p className="muted notify-help">«Проверить» станет доступен после разрешения уведомлений.</p>
        ) : null}
        {permission === "denied" ? (
          <p className="error">Разрешите уведомления в настройках сайта браузера, затем обновите страницу.</p>
        ) : null}
      </div>

      <div className="panel">
        <div className="page-head">
          <b>Последние уведомления</b>
          <button type="button" className="btn secondary" onClick={() => void loadNotices()}>
            Обновить
          </button>
        </div>
        {noticeError ? <p className="error">{noticeError}</p> : null}
        {notices.length === 0 ? <p className="empty">Пока пусто. Новая заявка появится здесь и в системном тосте.</p> : null}
        {notices.slice(0, 20).map((item) => (
          <div className="row" key={item.id}>
            <div>
              <b>{item.title}</b>
              <div className="muted">{item.body}</div>
              <div className="muted">
                {item.readAt ? "прочитано" : "новое"}
                {item.createdAt ? ` · ${new Date(item.createdAt).toLocaleString("ru-RU")}` : ""}
              </div>
            </div>
            <div className="actions">
              <a className="btn secondary" href={item.href || "/today"}>
                Открыть
              </a>
              {!item.readAt ? (
                <button
                  type="button"
                  className="btn"
                  onClick={async () => {
                    await api.markNotificationRead(item.id);
                    await loadNotices();
                  }}
                >
                  Прочитано
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <h3>База знаний</h3>
      <pre className="code">{JSON.stringify(state.data?.contentJson || {}, null, 2)}</pre>
      <form
        className="panel"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const result = (await api.sandbox(String(form.get("message")))) as any;
          setSandbox(result.reply_text);
        }}
      >
        <b>Проверить ИИ (песочница, без WhatsApp)</b>
        <textarea name="message" required />
        <button className="btn">Проверить</button>
        {sandbox ? <p>{sandbox}</p> : null}
      </form>
    </section>
  );
}

export function App() {
  const location = useLocation();
  const [me, setMe] = useState<any>(null);
  const [boot, setBoot] = useState<"loading" | "anon" | "ready" | "error">("loading");
  const [bootError, setBootError] = useState("");
  const [bootRevision, setBootRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setBoot("loading");
    api.me().then((data) => {
      if (cancelled) return;
      setMe(data);
      setBoot("ready");
    }).catch((error) => {
      if (cancelled) return;
      if (error?.status === 401) setBoot("anon");
      else {
        setBootError("Не удалось связаться с CRM. Проверьте соединение и повторите загрузку.");
        setBoot("error");
      }
    });
    return () => { cancelled = true; };
  }, [bootRevision]);
  if (boot === "loading") return <div className="state">Загрузка…</div>;
  if (boot === "error") return <div className="state"><p>{bootError}</p><button className="btn" onClick={() => setBootRevision(value => value + 1)}>Повторить</button></div>;
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="*"
        element={
          boot !== "ready" ? (
            <Navigate to="/login" />
          ) : (
            <Shell me={me}>
              <Suspense fallback={<div className="state" role="status">Загрузка раздела…</div>}>
              <Routes>
                <Route path="/today" element={<Today />} />
                <Route path="/control" element={<ControlPage />} />
                <Route path="/integrations" element={<IntegrationsPage />} />
                <Route path="/inquiries" element={<RequestsPage />} />
                <Route path="/requests" element={<Navigate to="/inquiries" replace />} />
                <Route path="/requests/:requestId" element={<RequestDetailPage key={location.pathname} />} />
                <Route path="/conversations" element={<ConversationsPage />} />
                <Route path="/conversations/:id" element={<ConversationsPage />} />
                <Route path="/deals" element={<DealsPage />} />
                <Route path="/deals/:dealId" element={<DealDetailPage key={location.pathname} />} />
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/contacts" element={<ClientsPage />} />
                <Route path="/contacts/:id" element={<ContactPage key={location.pathname} />} />
                <Route path="/clients/:id" element={<ContactPage key={location.pathname} />} />
                <Route path="/companies" element={<CompaniesPage />} />
                <Route path="/companies/:id" element={<CompanyPage key={location.pathname} />} />
                <Route path="/stats" element={<StatsPage />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/settings/ai-automation" element={<AiAutomationSettingsPage />} />
                <Route path="/admin" element={<Admin />} />
                <Route path="*" element={<Navigate to="/today" />} />
              </Routes>
              </Suspense>
            </Shell>
          )
        }
      />
    </Routes>
  );
}

function Admin() {  const [state] = useQuery(() => api.adminTenants() as Promise<any>);
  if (state.status !== "ready" || !state.data) return <StateView state={state} onRetry={() => location.reload()} empty="Нет компаний" />;
  return (
    <section>
      <h2>Кабинет платформы</h2>
      {state.data.items.map((item: any) => (
        <div className="row" key={item.id}>
          <div>
            <b>{item.name}</b>
            <div className="muted">{item.status} · сотрудников {item._count.memberships}</div>
          </div>
        </div>
      ))}
    </section>
  );
}
