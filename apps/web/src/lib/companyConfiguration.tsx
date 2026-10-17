import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createApiClient } from "@creolab/api-client";
import { api } from "./api";
import { useSession } from "./session";
import { uiMessage, useUiText } from "./uiText";
import { InlineFeedback } from "../components/InlineFeedback";
import "./companyConfiguration.css";

const ConfigurationContext = createContext<{ api: typeof api; company: any; billing: any; serviceFeatures: any } | null>(null);

export function useCompanyConfiguration() {
  const scoped = useContext(ConfigurationContext);
  const { me } = useSession();
  const href = (path: string) => {
    if (!scoped) return path;
    const base = `/admin/companies/${encodeURIComponent(scoped.company.id)}`;
    const destinations: Record<string, string> = {
      "/settings/ai-manager": "?tab=ai-manager&section=setup",
      "/settings/ai-automation": "?tab=ai-manager&section=rules",
      "/integrations": "?tab=integrations", "/integrations/esf": "?tab=integrations&section=esf",
      "/integrations/forms": "?tab=integrations&section=forms", "/integrations/webhook": "?tab=integrations&section=webhook",
      "/settings": "?tab=info", "/billing": "?tab=subscription",
    };
    return base + (destinations[path] || "");
  };
  return { api: scoped?.api || api, managed: Boolean(scoped), href,
    me: scoped ? { ...me, activeTenant: { tenant: scoped.company }, billing: scoped.billing, serviceFeatures: scoped.serviceFeatures } : me };
}

export function CompanyConfigurationProvider({ tenantId, children }: { tenantId: string; children: ReactNode }) {
  const t = useUiText();
  const [data, setData] = useState<any>(null), [error, setError] = useState(""), [revision, setRevision] = useState(0);
  const client = useMemo(() => createApiClient({ baseUrl: "", configurationTenantId: tenantId, formatErrorMessage: message => uiMessage(message) }), [tenantId]);
  useEffect(() => {
    let active = true; setData(null); setError("");
    void api.request(`/api/v1/admin/tenants/${encodeURIComponent(tenantId)}/configuration-context`)
      .then(result => { if (active) setData(result); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [tenantId, revision]);
  if (error) return <div className="panel stack"><InlineFeedback kind="error">{error}</InlineFeedback><button className="btn secondary" onClick={() => setRevision(value => value + 1)}>{t("Повторить")}</button></div>;
  if (!data || data.company.id !== tenantId) return <div className="state">{t("Загрузка настроек компании…")}</div>;
  return <ConfigurationContext.Provider value={{ ...data, api: client }}>
    <div className="company-configuration-notice" role="status"><b>{t("Настройка компании")}: {data.company.name}</b><p>{t("Вы работаете от имени администратора сервиса. Изменения сохраняются только для этой компании и записываются в историю действий.")}</p></div>
    {children}
  </ConfigurationContext.Provider>;
}
