import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, setTenant } from "./lib/api";
import {
  currentBrowserPermission,
  getBrowserNotificationPreference,
  requestBrowserNotificationPermission,
  setBrowserNotificationPreference,
  startNotificationPolling,
} from "./lib/browserNotifications";
import { ClientsPage } from "./pages/ClientsPage";
import { ContactPage } from "./pages/ContactPage";
import { ControlPage } from "./pages/ControlPage";
import { ConversationsPage } from "./pages/ConversationsPage";
import { IntegrationsPage } from "./pages/IntegrationsPage";
import { SituationPage } from "./pages/SituationPage";
import { TasksPage } from "./pages/TasksPage";

type LoadState<T> = { status: "loading" | "ready" | "error" | "empty"; data?: T; error?: string };

function useQuery<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
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
  }, deps);
  return [state, () => setState({ ...state })] as const;
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
  const tenantId = me.activeTenant?.tenant?.id;
  const [unreadNotices, setUnreadNotices] = useState(0);
  const [notifyBanner, setNotifyBanner] = useState(false);
  const links = [
    ["/today", "Ситуация"],
    ["/control", "Управление"],
    ["/inquiries", "Заявки"],
    ["/conversations", "Диалоги"],
    ["/deals", "Сделки"],
    ["/tasks", "Задачи"],
    ["/contacts", "Клиенты"],
    ["/integrations", "Интеграции"],
    ["/stats", "Статистика"],
    ["/settings", "Настройки"],
  ];

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
    const permission = currentBrowserPermission();
    if (permission === "default" && getBrowserNotificationPreference()) {
      setNotifyBanner(true);
    }
    if (permission === "granted" && getBrowserNotificationPreference()) {
      setNotifyBanner(false);
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
      onUnreadCount: setUnreadNotices,
      onNavigate: (url) => navigate(url),
    });
    return stop;
  }, [tenantId, navigate]);

  return (
    <div className="app-shell">
      <aside className="nav">
        <h1>CREOLAB CRM</h1>
        <p>{me.activeTenant?.tenant?.name || "Нет компании"}</p>
        {links.map(([to, label]) => (
          <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "active" : "")}>
            {label}
            {to === "/settings" && unreadNotices > 0 ? (
              <span className="nav-badge" title="Непрочитанные уведомления">
                {unreadNotices > 9 ? "9+" : unreadNotices}
              </span>
            ) : null}
          </NavLink>
        ))}
        {me.user.platformAdmin ? <NavLink to="/admin">Кабинет платформы</NavLink> : null}
        <button
          className="btn secondary"
          onClick={async () => {
            await api.request("/api/v1/auth/logout", { method: "POST", body: "{}" });
            navigate("/login");
          }}
        >
          Выйти
        </button>
      </aside>
      <main className="main">
        {notifyBanner ? (
          <div className="banner warn notify-banner">
            <span>Включите уведомления браузера — новые заявки и важные события придут даже при свёрнутом окне.</span>
            <div className="actions">
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  const result = await requestBrowserNotificationPermission();
                  if (result === "granted") setNotifyBanner(false);
                  else if (result === "denied") setNotifyBanner(false);
                }}
              >
                Включить
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => {
                  setBrowserNotificationPreference(false);
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
    </div>
  );
}

function Login() {
  const navigate = useNavigate();
  const [error, setError] = useState("");
  return (
    <div className="login">
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
        <h2>Вход в CRM</h2>
        <p className="muted">Телефон для входа не нужен. WhatsApp не обязателен.</p>
        <label>
          Email
          <input name="email" type="email" required defaultValue="owner@creolab.example" />
        </label>
        <label>
          Пароль
          <input name="password" type="password" required defaultValue="ChangeMeLocal1!" />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <button className="btn">Войти</button>
      </form>
    </div>
  );
}

function Today() {
  return <SituationPage />;
}

function Inquiries() {
  const [state] = useQuery(() => Promise.all([api.inquiries(), api.incomplete()]));
  const [phoneError, setPhoneError] = useState("");
  if (state.status !== "ready" || !state.data) {
    return <StateView state={state} onRetry={() => location.reload()} empty="Заявок нет. Создайте вручную или откройте форму." />;
  }
  const [inquiries, intakes] = state.data as [any, any];
  return (
    <section>
      <h2>Заявки</h2>
      <form
        className="panel"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          try {
            await api.createInquiry({
              name: form.get("name"),
              phone: form.get("phone"),
              subject: form.get("subject"),
              message: form.get("message"),
            });
            setPhoneError("");
            location.reload();
          } catch (err: any) {
            setPhoneError(err.body?.field_errors?.phone || err.message);
          }
        }}
      >
        <b>Новая заявка без WhatsApp</b>
        <label>Имя<input name="name" required /></label>
        <label>Телефон<input name="phone" required placeholder="+7 701 000 00 03" /></label>
        <label>Тема<input name="subject" /></label>
        <label>Задача<textarea name="message" /></label>
        {phoneError ? <p className="error">{phoneError}</p> : null}
        <button className="btn">Сохранить</button>
      </form>
      <h3>Требует уточнения телефона</h3>
      {intakes.items.map((item: any) => (
        <div className="row" key={item.id}>
          <div>
            <b>{item.reason}</b>
            <div className="muted">{new Date(item.receivedAt).toLocaleString("ru-RU")}</div>
          </div>
          <CompleteIntake id={item.id} />
        </div>
      ))}
      <h3>Полноценные заявки</h3>
      {inquiries.items.map((item: any) => (
        <div className="row" key={item.id}>
          <div>
            <b>{item.subject || item.contact?.name}</b>
            <div className="muted">{item.phoneRaw} · {item.source} · {item.status}</div>
          </div>
          <div className="actions">
            <button className="btn secondary" onClick={() => api.acceptInquiry(item.id).then(() => location.reload())}>Принять</button>
            <button className="btn" onClick={() => api.convertInquiry(item.id).then(() => location.reload())}>В сделку</button>
          </div>
        </div>
      ))}
    </section>
  );
}

function CompleteIntake({ id }: { id: string }) {
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        await api.completeIntake(id, { phone: form.get("phone"), name: form.get("name") });
        location.reload();
      }}
    >
      <input name="name" placeholder="Имя" />
      <input name="phone" required placeholder="+7..." />
      <button className="btn">Оформить</button>
    </form>
  );
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
  }, []);

  if (state.status !== "ready") {
    return <StateView state={state} onRetry={() => location.reload()} empty="Нет настроек" />;
  }

  const permissionLabel =
    permission === "granted"
      ? "разрешены"
      : permission === "denied"
        ? "запрещены в браузере"
        : permission === "unsupported"
          ? "не поддерживаются этим браузером"
          : "ещё не запрошены";

  return (
    <section>
      <h2>Настройки компании</h2>
      <p>
        <a href="/integrations">Подключить WhatsApp, форму, webhook и Telegram →</a>
      </p>
      <p>
        <a href="/control">Управлять ИИ, диалогами и задачами →</a>
      </p>

      <div className="panel">
        <b>Уведомления браузера</b>
        <p className="muted">
          Новые заявки, обращения без телефона и диалоги, где нужен человек. Работают при свёрнутом окне CRM, пока
          браузер запущен.
        </p>
        <p>
          Статус: <b>{permissionLabel}</b>
          {enabled ? " · включены в кабинете" : " · выключены в кабинете"}
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const result = await requestBrowserNotificationPermission();
              setPermission(result);
              if (result === "granted") {
                setEnabled(true);
                setBrowserNotificationPreference(true);
              }
            }}
          >
            {permission === "granted" ? "Разрешение уже есть" : "Разрешить уведомления"}
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
          <button
            type="button"
            className="btn secondary"
            disabled={permission !== "granted"}
            onClick={async () => {
              const { showBrowserNotification } = await import("./lib/browserNotifications");
              // force show even if tab focused
              const prev = document.visibilityState;
              await navigator.serviceWorker?.ready;
              const reg = await navigator.serviceWorker?.getRegistration();
              if (reg?.active) {
                reg.active.postMessage({
                  type: "SHOW_NOTIFICATION",
                  title: "CREOLAB CRM",
                  body: "Тестовое уведомление. Так будут приходить новые заявки.",
                  tag: `test-${Date.now()}`,
                  url: "/settings",
                  icon: "/favicon.svg",
                });
              } else {
                await showBrowserNotification({
                  title: "CREOLAB CRM",
                  body: "Тестовое уведомление. Так будут приходить новые заявки.",
                  tag: `test-${Date.now()}`,
                  url: "/settings",
                });
              }
              void prev;
            }}
          >
            Проверить
          </button>
        </div>
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
  const [me, setMe] = useState<any>(null);
  const [boot, setBoot] = useState<"loading" | "anon" | "ready">("loading");
  useEffect(() => {
    api
      .me()
      .then((data) => {
        setMe(data);
        setBoot("ready");
      })
      .catch(() => setBoot("anon"));
  }, []);
  if (boot === "loading") return <div className="state">Загрузка…</div>;
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
              <Routes>
                <Route path="/today" element={<Today />} />
                <Route path="/control" element={<ControlPage />} />
                <Route path="/integrations" element={<IntegrationsPage />} />
                <Route path="/inquiries" element={<Inquiries />} />
                <Route path="/conversations" element={<ConversationsPage />} />
                <Route path="/conversations/:id" element={<ConversationsPage />} />
                <Route path="/deals" element={<SimpleList title="Сделки" load={() => api.deals()} render={(item) => (
                  <div className="row" key={item.id}><div><b>{item.title}</b><div className="muted">{item.contact?.name} · {item.stage?.name} · {item.outcome}</div></div></div>
                )} />} />
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/contacts" element={<ClientsPage />} />
                <Route path="/contacts/:id" element={<ContactPage />} />
                <Route path="/clients/:id" element={<ContactPage />} />
                <Route path="/stats" element={<Stats />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/admin" element={<Admin />} />
                <Route path="*" element={<Navigate to="/today" />} />
              </Routes>
            </Shell>
          )
        }
      />
    </Routes>
  );
}

function Stats() {
  const [state] = useQuery(() => api.stats() as Promise<any>);
  if (state.status !== "ready" || !state.data) return <StateView state={state} onRetry={() => location.reload()} empty="Нет данных за день" />;
  return (
    <section>
      <h2>Статистика</h2>
      <p>Заявки сегодня: {state.data.inquiriesToday}</p>
      <p>{state.data.conversionLabel}: {state.data.conversionClosed ?? "—"}</p>
      <pre className="card">{JSON.stringify(state.data.paymentsByCurrency, null, 2)}</pre>
    </section>
  );
}

function Admin() {
  const [state] = useQuery(() => api.adminTenants() as Promise<any>);
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
