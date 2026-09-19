import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { notifySaved } from "../../components/SaveNotice";
import { FormConnectionWizard } from "./PlatformFormConnection";

type CatalogItem = {
  type: string;
  title: string;
  connectable?: boolean;
  steps?: string[];
  fields?: string[];
  multiple?: boolean;
  connectHint?: string;
};

type CompanyOption = {
  id: string;
  name: string;
  status?: string;
  integrationTypes?: string[];
};

type MemberOption = { id: string; name: string; email: string };

export function AssignIntegrationForm({
  item,
  companies,
  lockedTenantId,
}: {
  item: CatalogItem;
  companies: CompanyOption[];
  lockedTenantId?: string;
}) {
  if (!item.connectable) return null;
  if (item.type === "form") {
    return <FormConnectionWizard item={item} companies={companies} lockedTenantId={lockedTenantId} />;
  }
  return <ProviderAssignForm item={item} companies={companies} lockedTenantId={lockedTenantId} />;
}

function ProviderAssignForm({
  item,
  companies,
  lockedTenantId,
}: {
  item: CatalogItem;
  companies: CompanyOption[];
  lockedTenantId?: string;
}) {
  const [tenantId, setTenantId] = useState(lockedTenantId || "");
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [existing, setExisting] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [secret, setSecret] = useState("");

  useEffect(() => {
    if (lockedTenantId) setTenantId(lockedTenantId);
  }, [lockedTenantId]);

  useEffect(() => {
    if (!tenantId) {
      setMembers([]);
      setExisting(null);
      return;
    }
    let cancelled = false;
    Promise.all([api.adminCompanyIntegrations(tenantId), api.adminCompanyMembers(tenantId)])
      .then(([integrations, people]) => {
        if (cancelled) return;
        const data = integrations as any;
        const found = (data.items || []).find((row: any) => row.type === item.type) || null;
        setExisting(found);
        setMembers((people as any).members || []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Не удалось загрузить компанию");
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, item.type]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenantId || busy) return;
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      type: item.type,
      name: String(form.get("name") || ""),
      instanceId: String(form.get("instanceId") || ""),
      apiToken: String(form.get("apiToken") || ""),
      assigneeMembershipId: String(form.get("assigneeMembershipId") || ""),
    };
    setBusy(true);
    setError("");
    setSecret("");
    try {
      const result = existing && !item.multiple
        ? ((await api.adminUpdateCompanyIntegration(tenantId, existing.id, body)) as any)
        : ((await api.adminCreateCompanyIntegration(tenantId, body)) as any);
      setNote(result.note || (result.reachable === false ? "Сохранено, мост не ответил" : "Подключено к компании"));
      if (result.secret) setSecret(result.secret);
      if (result.bridgeSecret) setSecret(result.bridgeSecret);
      notifySaved(result.reachable ? "Мост ответил" : "Интеграция сохранена для компании");
      setExisting(result.id ? result : existing);
      const refreshed = (await api.adminCompanyIntegrations(tenantId)) as any;
      setExisting((refreshed.items || []).find((row: any) => row.type === item.type) || result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось подключить");
    } finally {
      setBusy(false);
    }
  }

  const fields = item.fields || [];
  const already = Boolean(existing) && !item.multiple;

  return (
    <form className="stack" key={`${item.type}-${tenantId}-${existing?.id || "new"}`} onSubmit={onSubmit}>
      {!lockedTenantId ? (
        <label>
          Компания
          <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} required>
            <option value="">Выберите компанию</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id} disabled={company.status === "suspended"}>
                {company.name}
                {company.integrationTypes?.includes(item.type) ? " · уже подключено" : ""}
                {company.status === "suspended" ? " · приостановлена" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {already && existing ? (
        <p className="muted">
          Сейчас: {existing.lifecycleLabel || existing.lifecycle}.{" "}
          {existing.schema?.instanceId ? `Instance: ${existing.schema.instanceId}` : null}{" "}
          <Link to={`/admin/companies/${tenantId}`}>Карточка компании</Link>
        </p>
      ) : null}
      {fields.includes("name") ? (
        <label>
          Название
          <input name="name" defaultValue={existing?.name || ""} placeholder={item.title} />
        </label>
      ) : null}
      {fields.includes("instanceId") ? (
        <label>
          Instance ID Green API
          <input name="instanceId" defaultValue={existing?.schema?.instanceId || ""} required={!already} />
        </label>
      ) : null}
      {fields.includes("apiToken") ? (
        <label>
          API Token
          <input
            name="apiToken"
            type="password"
            autoComplete="off"
            required={!already}
            placeholder={existing?.schema?.apiTokenSet ? "задан, введите чтобы заменить" : ""}
          />
        </label>
      ) : null}
      {fields.includes("assigneeMembershipId") ? (
        <label>
          Ответственный сотрудник
          <select name="assigneeMembershipId" defaultValue={existing?.assignment?.membershipId || ""}>
            <option value="">Администратор компании</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name} ({member.email})
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="actions">
        <button className="btn" disabled={busy || !tenantId}>
          {busy ? "Подключаем…" : already ? "Обновить подключение" : "Подключить к компании"}
        </button>
      </div>
      {note ? <p className="ok">{note}</p> : null}
      {secret ? <pre className="code">{secret}</pre> : null}
      {existing?.eventsUrl ? <p className="muted">Webhook: {existing.eventsUrl}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </form>
  );
}
