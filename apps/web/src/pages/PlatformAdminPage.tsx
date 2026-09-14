import { NavLink, Navigate, useLocation } from "react-router-dom";
import { useSession } from "../lib/session";
import { PlatformOverviewPage } from "./platform/PlatformOverviewPage";
import { PlatformCompaniesPage } from "./platform/PlatformCompaniesPage";
import { PlatformCompanyPage } from "./platform/PlatformCompanyPage";
import { PlatformMembersPage } from "./platform/PlatformMembersPage";
import { PlatformCatalogPage } from "./platform/PlatformCatalogPage";
import { PlatformServiceSettingsPage } from "./platform/PlatformServiceSettingsPage";
import { PlatformAuditPage } from "./platform/PlatformAuditPage";

const LINKS = [
  ["/admin", "Обзор"],
  ["/admin/companies", "Компании"],
  ["/admin/members", "Участники"],
  ["/admin/integrations", "Каталог интеграций"],
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
  if (pathname === "/admin/integrations") return <PlatformCatalogPage />;
  if (pathname === "/admin/settings") return <PlatformServiceSettingsPage />;
  if (pathname === "/admin/audit") return <PlatformAuditPage />;
  return <Navigate to="/admin" replace />;
}

export function PlatformAdminPage() {
  const { me } = useSession();
  const location = useLocation();
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
              {label}
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
