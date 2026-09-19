import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, setTenant } from "./lib/api";
import { NavIcon } from "./components/NavIcon";
import { BrandLogo } from "./components/BrandLogo";
import { SupportCenter, SupportHelpButton } from "./components/SupportCenter";
import { tip } from "./lib/tip";
import { applyAppearance, emptyCaps, SessionContext, type Capabilities } from "./lib/session";
import { normalizeLocale, t } from "./i18n";
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
const AvrEditorPage = lazy(() => import("./pages/AvrEditorPage").then(m => ({ default: m.AvrEditorPage })));
const InvoiceEditorPage = lazy(() => import("./pages/InvoiceEditorPage").then(m => ({ default: m.InvoiceEditorPage })));
const DocumentsPage = lazy(() => import("./pages/DocumentsPage").then(m => ({ default: m.DocumentsPage })));
const SignPage = lazy(() => import("./pages/SignPage").then(m => ({ default: m.SignPage })));
const VerifyPage = lazy(() => import("./pages/VerifyPage").then(m => ({ default: m.VerifyPage })));
const IntegrationsPage = lazy(() => import("./pages/IntegrationsPage").then(m => ({ default: m.IntegrationsPage })));
const EsfIntegrationPage = lazy(() => import("./pages/EsfIntegrationPage").then(m => ({ default: m.EsfIntegrationPage })));
const RequestDetailPage = lazy(() => import("./pages/RequestDetailPage").then(m => ({ default: m.RequestDetailPage })));
const RequestsPage = lazy(() => import("./pages/RequestsPage").then(m => ({ default: m.RequestsPage })));
const AiAutomationSettingsPage = lazy(() => import("./pages/AiAutomationSettingsPage").then(m => ({ default: m.AiAutomationSettingsPage })));
const SituationPage = lazy(() => import("./pages/SituationPage").then(m => ({ default: m.SituationPage })));
const StatsPage = lazy(() => import("./pages/StatsPage").then(m => ({ default: m.StatsPage })));
const TasksPage = lazy(() => import("./pages/TasksPage").then(m => ({ default: m.TasksPage })));
const SettingsPage = lazy(() => import("./pages/SettingsPage").then(m => ({ default: m.SettingsPage })));
const PlatformAdminPage = lazy(() => import("./pages/PlatformAdminPage").then(m => ({ default: m.PlatformAdminPage })));
const PlatformLoginPage = lazy(() => import("./pages/PlatformLoginPage").then(m => ({ default: m.PlatformLoginPage })));
const InvitePage = lazy(() => import("./pages/InvitePage").then(m => ({ default: m.InvitePage })));

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
  const [helpOpen, setHelpOpen] = useState(false);
  const [helpTicketId, setHelpTicketId] = useState<string | null>(null);
  const [helpUnread, setHelpUnread] = useState(0);
  const moreSheetRef = useRef<HTMLDivElement>(null);

  const caps: Capabilities = me?.capabilities || emptyCaps;
  const locale = normalizeLocale(me?.user?.locale);
  const platformAdmin = Boolean(me.user?.platformAdmin);
  const hasCompany = Boolean(tenantId);
  const inServiceAdmin = location.pathname.startsWith("/admin");

  const primaryTabs = (hasCompany
    ? [
        { to: "/today", label: t(locale, "nav.home"), icon: "home" },
        { to: "/conversations", label: t(locale, "nav.conversations"), icon: "chat" },
        { to: "/tasks", label: t(locale, "nav.tasks"), icon: "tasks" },
        { to: "/inquiries", label: t(locale, "nav.inquiries"), icon: "inquiries" },
      ]
    : platformAdmin
      ? [
          { to: "/admin", label: t(locale, "nav.platformOverview"), icon: "home" },
          { to: "/admin/companies", label: t(locale, "nav.platformCompanies"), icon: "inquiries" },
          { to: "/admin/members", label: t(locale, "nav.platformMembers"), icon: "tasks" },
        ]
      : [
          { to: "/today", label: t(locale, "nav.home"), icon: "home" },
          { to: "/settings", label: t(locale, "nav.settings"), icon: "tasks" },
        ]) as Array<{ to: string; label: string; icon: string }>;

  const workLinks = hasCompany ? [
    ["/today", t(locale, "nav.home")],
    ["/conversations", t(locale, "nav.conversations")],
    ["/tasks", t(locale, "nav.tasks")],
    ["/contacts", t(locale, "nav.contacts")],
    ["/companies", t(locale, "nav.companies")],
    ["/inquiries", t(locale, "nav.inquiries")],
    ["/deals", t(locale, "nav.deals")],
    ...(caps.documents ? [["/documents", t(locale, "nav.documents")] as [string, string]] : []),
  ] : [];
  const systemLinks = hasCompany ? [
    ...(!caps.manager ? [["/control", t(locale, "nav.control")] as [string, string]] : []),
    ...(caps.integrations ? [["/integrations", t(locale, "nav.integrations")] as [string, string]] : []),
    ...(caps.analytics ? [["/stats", t(locale, "nav.stats")] as [string, string]] : []),
    ["/settings", t(locale, "nav.settings")],
  ] : ([["/settings", t(locale, "nav.settings")] as [string, string]]);
  const platformLinks: Array<[string, string]> = platformAdmin ? [
    ["/admin", t(locale, "nav.platformOverview")],
    ["/admin/companies", t(locale, "nav.platformCompanies")],
    ["/admin/members", t(locale, "nav.platformMembers")],
    ["/admin/support", t(locale, "nav.platformSupport")],
    ["/admin/integrations", t(locale, "nav.platformCatalog")],
    ["/admin/ai-usage", t(locale, "nav.platformUsage")],
    ["/admin/settings", t(locale, "nav.platformSettings")],
    ["/admin/audit", t(locale, "nav.platformAudit")],
  ] : [];

  const moreLinks = (platformAdmin && !hasCompany
    ? [
        ["/admin/support", t(locale, "nav.platformSupport")],
        ["/admin/integrations", t(locale, "nav.platformCatalog")],
        ["/admin/ai-usage", t(locale, "nav.platformUsage")],
        ["/admin/settings", t(locale, "nav.platformSettings")],
        ["/admin/audit", t(locale, "nav.platformAudit")],
        ["/settings", t(locale, "nav.settings")],
      ]
    : [
        ["/admin", t(locale, "nav.platform"), platformAdmin],
        ["/control", t(locale, "nav.control"), hasCompany && !caps.manager],
        ["/contacts", t(locale, "nav.contacts"), hasCompany],
        ["/companies", t(locale, "nav.companies"), hasCompany],
        ["/deals", t(locale, "nav.deals"), hasCompany],
        ["/documents", t(locale, "nav.documents"), hasCompany && caps.documents],
        ["/integrations", t(locale, "nav.integrations"), hasCompany && caps.integrations],
        ["/stats", t(locale, "nav.stats"), hasCompany && caps.analytics],
        ["/settings", t(locale, "nav.settings"), true],
      ].filter((item) => item[2]) as Array<[string, string]>);

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
        : path === "/documents" ? "/documents?attention=1"
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
    "/today": t(locale, "nav.home"),
    "/control": t(locale, "nav.control"),
    "/inquiries": t(locale, "nav.inquiries"),
    "/requests": t(locale, "nav.inquiries"),
    "/conversations": t(locale, "nav.conversations"),
    "/deals": t(locale, "nav.deals"),
    "/documents": t(locale, "nav.documents"),
    "/tasks": t(locale, "nav.tasks"),
    "/contacts": t(locale, "nav.contacts"),
    "/companies": t(locale, "nav.companies"),
    "/integrations": t(locale, "nav.integrations"),
    "/stats": t(locale, "nav.stats"),
    "/settings": t(locale, "nav.settings"),
    "/admin/companies": t(locale, "nav.platformCompanies"),
    "/admin/members": t(locale, "nav.platformMembers"),
    "/admin/support": t(locale, "nav.platformSupport"),
    "/admin/integrations": t(locale, "nav.platformCatalog"),
    "/admin/ai-usage": t(locale, "nav.platformUsage"),
    "/admin/settings": t(locale, "nav.platformSettings"),
    "/admin/audit": t(locale, "nav.platformAudit"),
    "/admin": t(locale, "nav.platformOverview"),
  };
  const pageTitle =
    Object.entries(titleMap)
      .sort((a, b) => b[0].length - a[0].length)
      .find(([path]) => location.pathname === path || location.pathname.startsWith(`${path}/`))?.[1] ||
    "BasQar CRM";
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
        setNavBadges((prev) => ({
          ...badges,
          ...(platformAdmin ? { "/admin/support": Number(prev["/admin/support"] || 0) } : {}),
        }));
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
  }, [tenantId, location.pathname, platformAdmin]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const help = params.get("help");
    if (help && !location.pathname.startsWith("/admin")) {
      setHelpTicketId(help);
      setHelpOpen(true);
    }
  }, [location.search]);

  useEffect(() => {
    if (!hasCompany) return;
    let cancelled = false;
    async function loadHelp() {
      try {
        const data = (await api.supportUnread()) as { unread?: number };
        if (!cancelled) setHelpUnread(Number(data.unread || 0));
      } catch {
        if (!cancelled) setHelpUnread(0);
      }
    }
    void loadHelp();
    const timer = window.setInterval(() => {
      if (!cancelled) void loadHelp();
    }, 20000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [hasCompany, tenantId]);

  useEffect(() => {
    if (!platformAdmin) return;
    let cancelled = false;
    async function loadAdminHelp() {
      try {
        const data = (await api.adminSupportUnread()) as { unread?: number };
        if (cancelled) return;
        setNavBadges((prev) => ({ ...prev, "/admin/support": Number(data.unread || 0) }));
      } catch {
        /* keep previous */
      }
    }
    void loadAdminHelp();
    const timer = window.setInterval(() => {
      if (!cancelled) void loadAdminHelp();
    }, 20000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [platformAdmin]);

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
    navigate(platformAdmin ? "/admin/login" : "/login");
  }

  return (
    <div className={`app-shell ${moreOpen ? "more-open" : ""}`}>
      <header className="mobile-topbar">
          <div className="mobile-topbar-title">
          <b>{pageTitle}</b>
          <span className="muted">{me.activeTenant?.tenant?.name || "Нет компании"}</span>
        </div>
        {inServiceAdmin ? null : (
        <SupportHelpButton unread={helpUnread} onClick={() => { setHelpTicketId(null); setHelpOpen(true); }} />
        )}
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
          <BrandLogo />
          <p>{me.activeTenant?.tenant?.name || "Нет компании"}</p>
        </div>
        <nav className="nav-links">
          {(
            [
              workLinks.length ? { section: t(locale, "nav.work"), links: workLinks } : null,
              platformAdmin && !hasCompany ? { section: t(locale, "nav.platform"), links: platformLinks } : null,
              { section: t(locale, "nav.system"), links: systemLinks },
              platformAdmin && hasCompany ? { section: t(locale, "nav.platform"), links: platformLinks } : null,
            ] as Array<{ section: string; links: Array<[string, string]> } | null>
          ).filter((block): block is { section: string; links: Array<[string, string]> } => Boolean(block?.links.length)).map((block) => (
            <div key={block.section}>
              <p className="nav-section">{block.section}</p>
              {block.links.map(([to, label]) => {
                const count = badgeCount(to);
                const hint = badgeHint(
                  to,
                  to === "/settings" ? "Непрочитанные уведомления" : to === "/admin/support" ? "Непрочитанные обращения" : "Требует внимания",
                );
                return (
                  <NavLink
                    key={to}
                    to={navTo(to)}
                    end={to === "/admin"}
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
            </div>
          ))}
        </nav>
        {inServiceAdmin ? null : (
        <button
          type="button"
          className="nav-help"
          onClick={() => {
            setHelpTicketId(null);
            setHelpOpen(true);
          }}
          aria-label={helpUnread > 0 ? `${t(locale, "nav.help")}. Есть непрочитанные ответы` : t(locale, "nav.help")}
        >
          <span className="nav-link-label">
            <NavIcon to="/help" />
            {t(locale, "nav.help")}
          </span>
          {helpUnread > 0 ? <span className="nav-badge">{formatBadge(helpUnread)}</span> : null}
        </button>
        )}
        <button className="btn secondary nav-logout" onClick={logout} {...tip("Завершить сеанс в этом браузере")}>
          {t(locale, "nav.logout")}
        </button>
      </aside>

      <main className="main">
        <div className="workspace-toolbar">
          <div className="workspace-breadcrumb"><span>{pageTitle}</span></div>
          <div className="workspace-identity">
            {inServiceAdmin ? null : (
            <SupportHelpButton unread={helpUnread} onClick={() => { setHelpTicketId(null); setHelpOpen(true); }} />
            )}
            <span>{me.user.name}</span>
            <span className="workspace-avatar" aria-hidden="true">{String(me.user.name || "C").split(" ").slice(0, 2).map((part) => part[0]).join("")}</span>
          </div>
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
        <div className="more-sheet-heading"><b className="more-sheet-title">{t(locale, "nav.more")}</b><button type="button" className="btn secondary" onClick={() => setMoreOpen(false)}>{t(locale, "common.close")}</button></div>
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
        </nav>
        <button type="button" className="btn secondary" onClick={logout} {...tip("Завершить сеанс в этом браузере")}>
          {t(locale, "nav.logout")}
        </button>
      </div>

      {inServiceAdmin ? null : (
      <SupportCenter
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        initialTicketId={helpTicketId}
        onUnread={setHelpUnread}
        canCreateTicket={hasCompany}
      />
      )}

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
          <span className="tab-label">{t(locale, "nav.more")}</span>
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
          <BrandLogo variant="login" />
          <p>{t(normalizeLocale(null), "login.brand")}</p>
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
              const dest = result.user?.user?.platformAdmin && !tenantId ? "/admin" : "/today";
              window.location.assign(dest);
            } catch (err) {
              const message = err instanceof Error ? err.message : "Ошибка входа";
              setError(
                message === "Failed to fetch" || message === "HTTP 500"
                  ? "Сейчас не удаётся войти. Попробуйте ещё раз через минуту."
                  : message,
              );
            }
          }}
        >
          <h2>{t(normalizeLocale(null), "login.title")}</h2>
          <p className="muted">{t(normalizeLocale(null), "login.hint")}</p>
          <label>
            {t(normalizeLocale(null), "login.email")}
            <input name="email" type="email" required autoComplete="username" />
          </label>
          <label>
            {t(normalizeLocale(null), "login.password")}
            <input
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <button className="btn">{t(normalizeLocale(null), "login.submit")}</button>
          <p className="muted login-alt">
            <Link to="/admin/login">{t(normalizeLocale(null), "login.platformLink")}</Link>
          </p>
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

export function App() {
  const location = useLocation();
  const [me, setMe] = useState<any>(null);
  const [boot, setBoot] = useState<"loading" | "anon" | "ready" | "error" | "tenant-blocked">("loading");
  const [bootError, setBootError] = useState("");
  const [bootRevision, setBootRevision] = useState(0);
  const [tenantBlock, setTenantBlock] = useState<{
    code: string;
    message: string;
    memberships: Array<{ tenantId: string; name: string; role: string }>;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setBoot("loading");
    api.me().then((data) => {
      if (cancelled) return;
      setMe(data);
      applyAppearance((data as any).user);
      const recovered = (data as any).activeTenant?.tenant?.id as string | undefined;
      if (recovered && !localStorage.getItem("crm_tenant")) setTenant(recovered);
      setBoot("ready");
    }).catch((error) => {
      if (cancelled) return;
      const code = String((error as { code?: string })?.code || "");
      if ((error as { status?: number })?.status === 401) setBoot("anon");
      else if (
        (error as { status?: number })?.status === 403 &&
        (code === "membership_suspended" || code === "tenant_suspended" || code === "unknown_tenant")
      ) {
        const details = (error as { body?: { details?: { memberships?: Array<{ tenantId: string; name: string; role: string }> } } })
          .body?.details;
        setTenantBlock({
          code,
          message: error instanceof Error ? error.message : "Нет доступа к выбранной компании",
          memberships: details?.memberships || [],
        });
        setBoot("tenant-blocked");
      } else {
        setBootError("Не удалось связаться с CRM. Проверьте соединение и повторите загрузку.");
        setBoot("error");
      }
    });
    return () => { cancelled = true; };
  }, [bootRevision]);
  if (boot === "loading") return <div className="state">{t(normalizeLocale(null), "common.loading")}</div>;
  if (boot === "error") return <div className="state"><p>{bootError}</p><button className="btn" onClick={() => setBootRevision(value => value + 1)}>Повторить</button></div>;
  if (boot === "tenant-blocked" && tenantBlock) {
    return (
      <div className="login">
        <div className="login-stage">
          <div className="login-brand">
            <BrandLogo variant="login" />
          </div>
          <div className="panel">
            <h2>Компания недоступна</h2>
            <p className="error">{tenantBlock.message}</p>
            {tenantBlock.memberships.length ? (
              <>
                <p className="muted">Выберите доступную организацию. Автоматического перехода на другую компанию нет.</p>
                <div className="tenant-choice-list">
                  {tenantBlock.memberships.map((item) => (
                    <button
                      key={item.tenantId}
                      className="btn"
                      type="button"
                      onClick={() => {
                        setTenant(item.tenantId);
                        window.location.assign("/today");
                      }}
                    >
                      {item.name}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p className="muted">Других доступных компаний нет. Обратитесь к администратору.</p>
            )}
            <p className="muted login-alt">
              <Link to="/login" onClick={() => localStorage.removeItem("crm_tenant")}>Выйти на экран входа</Link>
            </p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/admin/login"
        element={
          boot === "ready" && me?.user?.platformAdmin ? (
            <Navigate to="/admin" replace />
          ) : (
            <Suspense fallback={<div className="state">{t(normalizeLocale(null), "common.loading")}</div>}>
              <PlatformLoginPage />
            </Suspense>
          )
        }
      />
      <Route
        path="/invite/:token"
        element={
          <Suspense fallback={<div className="state">Загрузка…</div>}>
            <InvitePage />
          </Suspense>
        }
      />
      <Route
        path="/sign/:token"
        element={
          <Suspense fallback={<div className="state">Загрузка…</div>}>
            <SignPage />
          </Suspense>
        }
      />
      <Route
        path="/verify/:verificationId"
        element={
          <Suspense fallback={<div className="state">Загрузка…</div>}>
            <VerifyPage />
          </Suspense>
        }
      />
      <Route
        path="*"
        element={
          boot !== "ready" ? (
            <Navigate to={location.pathname.startsWith("/admin") ? "/admin/login" : "/login"} replace />
          ) : (
            <SessionContext.Provider value={{ me, caps: me?.capabilities || emptyCaps }}>
            <Shell me={me}>
              <Suspense fallback={<div className="state" role="status">Загрузка раздела…</div>}>
              <Routes>
                <Route path="/today" element={!me?.activeTenant && me?.user?.platformAdmin ? <Navigate to="/admin" replace /> : <Today />} />
                <Route path="/control" element={me?.capabilities?.manager ? <Navigate to="/today" replace /> : <ControlPage />} />
                <Route path="/integrations" element={me?.capabilities?.integrations ? <IntegrationsPage /> : <Navigate to="/today" replace />} />
                <Route path="/integrations/esf" element={me?.capabilities?.documents ? <EsfIntegrationPage /> : <Navigate to="/today" replace />} />
                <Route path="/inquiries" element={<RequestsPage />} />
                <Route path="/requests" element={<Navigate to="/inquiries" replace />} />
                <Route path="/requests/:requestId" element={<RequestDetailPage key={location.pathname} />} />
                <Route path="/conversations" element={<ConversationsPage />} />
                <Route path="/conversations/:id" element={<ConversationsPage />} />
                <Route path="/deals" element={<DealsPage />} />
                <Route path="/deals/:dealId" element={<DealDetailPage key={location.pathname} />} />
                <Route path="/documents" element={me?.capabilities?.documents ? <DocumentsPage /> : <Navigate to="/today" replace />} />
                <Route path="/documents/avr/new" element={me?.capabilities?.documents ? <AvrEditorPage /> : <Navigate to="/today" replace />} />
                <Route path="/documents/avr/:id" element={me?.capabilities?.documents ? <AvrEditorPage /> : <Navigate to="/today" replace />} />
                <Route path="/documents/invoices/new" element={me?.capabilities?.documents ? <InvoiceEditorPage /> : <Navigate to="/today" replace />} />
                <Route path="/documents/invoices/:id" element={me?.capabilities?.documents ? <InvoiceEditorPage /> : <Navigate to="/today" replace />} />
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/contacts" element={<ClientsPage />} />
                <Route path="/contacts/:id" element={<ContactPage key={location.pathname} />} />
                <Route path="/clients/:id" element={<ContactPage key={location.pathname} />} />
                <Route path="/companies" element={<CompaniesPage />} />
                <Route path="/companies/:id" element={<CompanyPage key={location.pathname} />} />
                <Route path="/stats" element={me?.capabilities?.analytics ? <StatsPage /> : <Navigate to="/today" replace />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/ai-automation" element={me?.capabilities?.aiSettings ? <AiAutomationSettingsPage /> : <Navigate to="/settings" replace />} />
                <Route path="/admin/*" element={me?.user?.platformAdmin ? <PlatformAdminPage /> : <Navigate to="/today" replace />} />
                <Route path="*" element={<Navigate to={me?.user?.platformAdmin && !me?.activeTenant ? "/admin" : "/today"} />} />
              </Routes>
              </Suspense>
            </Shell>
            </SessionContext.Provider>
          )
        }
      />
    </Routes>
  );
}
