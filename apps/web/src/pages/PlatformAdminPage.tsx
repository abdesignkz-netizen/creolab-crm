import { Navigate, useLocation } from "react-router-dom";
import { useSession } from "../lib/session";
import { PlatformOverviewPage } from "./platform/PlatformOverviewPage";
import { PlatformCompaniesPage } from "./platform/PlatformCompaniesPage";
import { PlatformCompanyPage } from "./platform/PlatformCompanyPage";
import { PlatformMembersPage } from "./platform/PlatformMembersPage";
import { PlatformCatalogPage } from "./platform/PlatformCatalogPage";
import { PlatformServiceSettingsPage } from "./platform/PlatformServiceSettingsPage";
import { PlatformAuditPage } from "./platform/PlatformAuditPage";
import { PlatformAiUsagePage } from "./platform/PlatformAiUsagePage";
import { PlatformAiManagersPage } from "./platform/PlatformAiManagersPage";
import { PlatformSupportPage } from "./platform/PlatformSupportPage";

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
  if (pathname === "/admin/ai-managers" || pathname.startsWith("/admin/ai-managers/")) return <PlatformAiManagersPage />;
  if (pathname === "/admin/ai-usage") return <PlatformAiUsagePage />;
  if (pathname === "/admin/audit") return <PlatformAuditPage />;
  return <Navigate to="/admin" replace />;
}

export function PlatformAdminPage() {
  const { me } = useSession();
  if (!me?.user?.platformAdmin) return <Navigate to="/today" replace />;
  return <AdminSection />;
}
