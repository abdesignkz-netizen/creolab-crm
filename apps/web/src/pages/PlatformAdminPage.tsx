import { useEffect, useState } from "react";
import { NavLink, Navigate, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { PlatformOverviewPage } from "./platform/PlatformOverviewPage";
import { PlatformCompaniesPage } from "./platform/PlatformCompaniesPage";
import { PlatformCompanyPage } from "./platform/PlatformCompanyPage";
import { PlatformMembersPage } from "./platform/PlatformMembersPage";
import { PlatformCatalogPage } from "./platform/PlatformCatalogPage";
import { PlatformServiceSettingsPage } from "./platform/PlatformServiceSettingsPage";
import { PlatformAuditPage } from "./platform/PlatformAuditPage";
import { PlatformAiUsagePage } from "./platform/PlatformAiUsagePage";
import { PlatformSupportPage } from "./platform/PlatformSupportPage";

const LINKS = [
  ["/admin", "Обзор"],
  ["/admin/companies", "Компании"],
  ["/admin/members", "Участники"],
  ["/admin/support", "Поддержка"],
  ["/admin/integrations", "Каталог интеграций"],
  ["/admin/ai-usage", "AI Usage"],
  ["/admin/settings", "Настройки сервиса"],
  ["/admin/audit", "Журнал действий"],
] as const;

function AdminSection() {
  const { pathname } = useLocation();
  if (pathname === "/admin") return <PlatformOverviewPage />;
  if (pathname === "/admin/companies/new") return <PlatformCompaniesPage mode="new" />;
  if (pathname === "/admin/companies") return <PlatformCompaniesPage mode="list" />;
  if (pathname.startsWith("/admin/companies/")) return <PlatformCompanyPage />;
  if (pathname === "/admin/members") return <PlatformMembersPage />;
  if (pathname === "/admin/support" || pathname.startsWith("/admin/support/")) return <PlatformSupportPage />;
  if (pathname === "/admin/integrations") return <PlatformCatalogPage />;
  if (pathname === "/admin/settings") return <PlatformServiceSettingsPage />;
  if (pathname === "/admin/ai-usage") return <PlatformAiUsagePage />;
  if (pathname === "/admin/audit") return <PlatformAuditPage />;
  return <Navigate to="/admin" replace />;
}

export function PlatformAdminPage() {
  const { me } = useSession();
  const location = useLocation();
  const [supportUnread, setSupportUnread] = useState(0);

  useEffect(() => {
    if (!me?.user?.platformAdmin) return;
    let cancelled = false;
    async function load() {
      try {
        const data = (await api.adminSupportUnread()) as { unread?: number };
        if (!cancelled) setSupportUnread(Number(data.unread || 0));
      } catch {
        if (!cancelled) setSupportUnread(0);
      }
    }
    void load();
    const timer = window.setInterval(() => {
      if (!cancelled) void load();
    }, 20000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [location.pathname, me?.user?.platformAdmin]);

  if (!me?.user?.platformAdmin) return <Navigate to="/today" replace />;

  return (
    <section className="settings-page">
      <h2>Администрирование сервиса</h2>
      <p className="muted">Организации, подключённые к CRM, их участники и подключения. Это не справочник контрагентов.</p>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Администрирование сервиса">
          {LINKS.map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/admin"}
              className={({ isActive }) => (isActive || (to !== "/admin" && location.pathname.startsWith(to)) ? "active" : "")}
            >
              <span className="nav-link-label">{label}</span>
              {to === "/admin/support" && supportUnread > 0 ? (
                <span className="nav-badge">{supportUnread > 9 ? "9+" : supportUnread}</span>
              ) : null}
            </NavLink>
          ))}
        </nav>
        <div>
          <AdminSection />
        </div>
      </div>
    </section>
  );
}
