import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../../lib/api";
import { formatDateTime } from "../../lib/datetime";
import { notifySaved } from "../../components/SaveNotice";

type CatalogItem = {
  type: string;
  title: string;
  connectable?: boolean;
  steps?: string[];
  fields?: string[];
  multiple?: boolean;
};

type CompanyOption = {
  id: string;
  name: string;
  status?: string;
  integrationTypes?: string[];
};

type MemberOption = { id: string; name: string; email: string };

type FormConnection = {
  id: string;
  type?: string;
  name: string;
  tenantId: string;
  lifecycle?: string;
  lifecycleLabel?: string;
  lastSuccessAt?: string | null;
  lastError?: string | null;
  mapping?: { version?: number; fields?: Record<string, string> } | Record<string, string>;
  assignment?: { kind?: string; membershipId?: string };
  forms?: Array<{
    id: string;
    publicKey: string;
    name: string;
    submitUrl: string;
    fields?: unknown;
    active?: boolean;
  }>;
};

type PlatformTab = "tilda" | "html" | "wordpress" | "api";

const CRM_FIELD_LABEL: Record<string, string> = {
  name: "Имя",
  phone: "Телефон",
  email: "Email",
  message: "Комментарий",
  company: "Компания",
  service: "Услуга",
  budget: "Бюджет",
  city: "Город",
  deadline: "Срок",
};

const REQUIRED_CRM_FIELDS = new Set(["name", "phone"]);

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}

function mappingRows(mapping: FormConnection["mapping"]) {
  const fields =
    mapping && typeof mapping === "object" && "fields" in mapping && mapping.fields
      ? mapping.fields
      : ((mapping as Record<string, string> | undefined) || {});
  const grouped: Record<string, string[]> = {
    name: ["name", "Name", "your-name", "Имя"],
    phone: ["phone", "Phone", "mobile", "your-phone", "Телефон"],
    email: ["email", "Email", "your-email"],
    message: ["message", "comment", "Comments", "your-message"],
    company: ["company", "business"],
    service: ["service", "subject", "your-subject"],
  };
  for (const [from, to] of Object.entries(fields)) {
    if (!to || typeof to !== "string") continue;
    grouped[to] = grouped[to] || [];
    if (!grouped[to].includes(from)) grouped[to].unshift(from);
  }
  return Object.entries(grouped).map(([to, from]) => ({
    from: Array.from(new Set(from)).join(", "),
    to: CRM_FIELD_LABEL[to] || to,
    required: REQUIRED_CRM_FIELDS.has(to),
  }));
}

function htmlExample(endpoint: string) {
  return `fetch(${JSON.stringify(endpoint)}, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    name: 'Иван',
    phone: '+77001234567',
    email: 'example@example.com',
    message: 'Комментарий'
  })
});`;
}

function jsonExample(endpoint: string) {
  return `POST ${endpoint}
Content-Type: application/json

{
  "name": "Иван",
  "phone": "+77001234567",
  "email": "example@example.com",
  "message": "Комментарий"
}`;
}

export function FormConnectionWizard({
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
  const [connections, setConnections] = useState<FormConnection[]>([]);
  const [existing, setExisting] = useState<FormConnection | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(lockedTenantId));
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState<"endpoint" | "code" | "">("");
  const [platform, setPlatform] = useState<PlatformTab>("tilda");
  const [testName, setTestName] = useState("Тестовая заявка");
  const [testPhone, setTestPhone] = useState("+77001234567");
  const [testEmail, setTestEmail] = useState("test@example.com");
  const [testBusy, setTestBusy] = useState(false);
  const [testOk, setTestOk] = useState(false);
  const [testError, setTestError] = useState("");
  const [testDetail, setTestDetail] = useState("");
  const [showTestDetail, setShowTestDetail] = useState(false);

  useEffect(() => {
    if (lockedTenantId) setTenantId(lockedTenantId);
  }, [lockedTenantId]);

  async function loadCompany(id: string, preferId?: string) {
    setLoading(true);
    setError("");
    try {
      const [integrations, people] = await Promise.all([
        api.adminCompanyIntegrations(id) as Promise<{ items?: FormConnection[] }>,
        api.adminCompanyMembers(id) as Promise<{ members?: MemberOption[] }>,
      ]);
      const forms = ((integrations.items || []).filter((row) => row.type === "form")).sort((a, b) =>
        String(b.lastSuccessAt || "").localeCompare(String(a.lastSuccessAt || "")),
      );
      setConnections(forms);
      setMembers(people.members || []);
      const next = (preferId && forms.find((row) => row.id === preferId)) || forms[0] || null;
      setExisting(next);
      if (preferId || forms.length) setCreatingNew(false);
      else setCreatingNew(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить компанию");
      setConnections([]);
      setExisting(null);
      setMembers([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!tenantId) {
      setMembers([]);
      setConnections([]);
      setExisting(null);
      setCreatingNew(true);
      setNote("");
      setTestOk(false);
      return;
    }
    void loadCompany(tenantId);
  }, [tenantId]);

  const selectedCompany = companies.find((company) => company.id === tenantId)?.name || "";
  const companyName = selectedCompany && selectedCompany !== "Эта компания" ? selectedCompany : "этой компании";
  const form = existing?.forms?.[0];
  const endpoint = form?.submitUrl || "";
  const publicKey = form?.publicKey || "";
  const showCreate = Boolean(tenantId) && !loading && (creatingNew || !existing);
  const assigneeLabel = useMemo(() => {
    const membershipId = existing?.assignment?.membershipId;
    if (membershipId) {
      const member = members.find((item) => item.id === membershipId);
      return member ? `${member.name} (${member.email})` : "Выбранный сотрудник компании";
    }
    return "Администратор компании";
  }, [existing, members]);

  async function onCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!tenantId || busy) return;
    const formData = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    setTestOk(false);
    try {
      const result = (await api.adminCreateCompanyIntegration(tenantId, {
        type: "form",
        name: String(formData.get("name") || "").trim() || "Форма сайта",
        assigneeMembershipId: String(formData.get("assigneeMembershipId") || ""),
      })) as FormConnection & { note?: string };
      setNote(result.note || "Адрес для приёма заявок создан. Теперь подключите к нему форму сайта компании.");
      notifySaved("Подключение создано");
      setCreatingNew(false);
      await loadCompany(tenantId, result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать подключение");
    } finally {
      setBusy(false);
    }
  }

  async function markCopied(kind: "endpoint" | "code", value: string) {
    try {
      await copyText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(""), 1600);
    } catch {
      setError("Не удалось скопировать");
    }
  }

  async function sendTest() {
    if (!publicKey || testBusy) return;
    setTestBusy(true);
    setTestOk(false);
    setTestError("");
    setTestDetail("");
    setShowTestDetail(false);
    try {
      const response = await fetch(`/public/forms/${publicKey}/submissions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: testName.trim(),
          phone: testPhone.trim(),
          email: testEmail.trim(),
          message: "Тестовая заявка из панели администратора сервиса",
          is_test: true,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        code?: string;
        message?: string;
        field_errors?: Record<string, string>;
      };
      if (!response.ok || payload.ok === false) {
        setTestError("Не удалось принять тестовую заявку.");
        setTestDetail(
          [payload.message, payload.code, payload.field_errors ? JSON.stringify(payload.field_errors) : ""]
            .filter(Boolean)
            .join(" · ") || `HTTP ${response.status}`,
        );
        return;
      }
      setTestOk(true);
      notifySaved("Тестовая заявка получена");
      await loadCompany(tenantId, existing?.id);
    } catch (err) {
      setTestError("Не удалось принять тестовую заявку.");
      setTestDetail(err instanceof Error ? err.message : "Сеть недоступна");
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <div className="stack">
      <p className="muted">
        Создайте адрес для приёма заявок с сайта компании. После создания вы получите инструкцию по подключению и
        сможете отправить тестовую заявку.
      </p>

      {!lockedTenantId ? (
        <label>
          Компания
          <select
            value={tenantId}
            onChange={(event) => {
              setTenantId(event.target.value);
              setLoading(Boolean(event.target.value));
              setNote("");
              setTestOk(false);
            }}
            required
          >
            <option value="">Выберите компанию</option>
            {companies.map((company) => (
              <option key={company.id} value={company.id} disabled={company.status === "suspended"}>
                {company.name}
                {company.integrationTypes?.includes("form") ? " · есть подключение" : ""}
                {company.status === "suspended" ? " · приостановлена" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {loading ? <p className="muted">Загрузка подключений…</p> : null}

      {tenantId && connections.length > 0 && !creatingNew ? (
        <label>
          Подключение
          <select
            value={existing?.id || ""}
            onChange={(event) => {
              const next = connections.find((row) => row.id === event.target.value) || null;
              setExisting(next);
              setTestOk(false);
              setNote("");
            }}
          >
            {connections.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name} · {row.lifecycleLabel || row.lifecycle}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {showCreate ? (
        <form className="stack" onSubmit={onCreate}>
          <label>
            Название
            <input name="name" defaultValue="Форма сайта" placeholder={item.title} />
          </label>
          <label>
            Ответственный сотрудник
            <select name="assigneeMembershipId" defaultValue="">
              <option value="">Администратор компании</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name} ({member.email})
                </option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button className="btn" disabled={busy || !tenantId}>
              {busy ? "Создаём…" : "Создать подключение"}
            </button>
            {existing && creatingNew ? (
              <button className="btn secondary" type="button" onClick={() => setCreatingNew(false)}>
                К существующему
              </button>
            ) : null}
          </div>
        </form>
      ) : null}

      {existing && !creatingNew ? (
        <div className="stack">
          {note ? <p className="ok">{note}</p> : null}
          <div className="page-head">
            <div>
              <b>{existing.name}</b>
              <div className="muted">
                Компания: {companyName}
                {" · "}
                <span className={`badge ${existing.lifecycle === "working" ? "" : "warn"}`}>
                  {existing.lifecycleLabel || existing.lifecycle}
                </span>
              </div>
            </div>
            <div className="actions">
              {item.multiple ? (
                <button
                  className="btn secondary"
                  type="button"
                  onClick={() => {
                    setCreatingNew(true);
                    setNote("");
                    setTestOk(false);
                  }}
                >
                  Ещё одно подключение
                </button>
              ) : null}
              <Link className="btn secondary" to={`/admin/companies/${tenantId}`}>
                Карточка компании
              </Link>
            </div>
          </div>

          <fieldset className="field-block">
            <legend>Адрес для приёма заявок</legend>
            <div className="form-connect-endpoint">
              <code>{endpoint}</code>
              <button className="btn secondary" type="button" onClick={() => void markCopied("endpoint", endpoint)}>
                {copied === "endpoint" ? "Скопировано" : "Копировать"}
              </button>
            </div>
            <p className="muted" style={{ marginTop: 8 }}>
              Заявки с сайта компании должны отправляться POST-запросом на этот адрес.
            </p>
            {existing.lifecycle === "working" && existing.lastSuccessAt ? (
              <p className="ok">
                ✓ Последняя заявка получена {formatDateTime(existing.lastSuccessAt)}
              </p>
            ) : (
              <p className="muted">Адрес создан. Успешных заявок с сайта пока нет.</p>
            )}
          </fieldset>

          <fieldset className="field-block">
            <legend>Как подключить форму</legend>
            <div className="segmented" role="tablist" aria-label="Платформа сайта" style={{ marginTop: 0 }}>
              {(
                [
                  ["tilda", "Tilda"],
                  ["html", "HTML / JavaScript"],
                  ["wordpress", "WordPress"],
                  ["api", "Webhook / API"],
                ] as Array<[PlatformTab, string]>
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={platform === id ? "btn" : "btn secondary"}
                  onClick={() => setPlatform(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            {platform === "tilda" ? (
              <div className="notify-steps" style={{ marginTop: 12 }}>
                <ol>
                  <li>В Tilda откройте «Настройки сайта» → «Формы» → «Webhook».</li>
                  <li>Вставьте адрес для приёма заявок и сохраните. При запросе назначьте webhook формам сайта.</li>
                  <li>
                    Если webhook не назначен сразу — в редакторе страницы откройте блок формы, в Content включите
                    WEBHOOK и опубликуйте страницу.
                  </li>
                  <li>
                    Стандартные поля Tilda <code>Name</code>, <code>Phone</code>, <code>Email</code>,{" "}
                    <code>Comments</code> принимаются как есть. Имя и телефон обязательны.
                  </li>
                  <li>
                    Отправьте заявку с опубликованной формы. Tilda шлёт{" "}
                    <code>application/x-www-form-urlencoded</code> — этот формат поддерживается тем же адресом.
                  </li>
                </ol>
                <div className="actions">
                  <button className="btn secondary" type="button" onClick={() => void markCopied("endpoint", endpoint)}>
                    {copied === "endpoint" ? "Скопировано" : "Копировать адрес"}
                  </button>
                </div>
                <p className="muted">
                  Пустой тест из настроек Tilda без имени и телефона CRM отклонит. Проверяйте заполненной формой или
                  блоком ниже.
                </p>
              </div>
            ) : null}

            {platform === "html" ? (
              <div className="stack" style={{ marginTop: 12 }}>
                <p className="muted">
                  С внешнего сайта отправьте JSON на адрес компании. Ключ CRM в HTML размещать не нужно.
                </p>
                <pre className="code">{htmlExample(endpoint)}</pre>
                <div className="actions">
                  <button
                    className="btn secondary"
                    type="button"
                    onClick={() => void markCopied("code", htmlExample(endpoint))}
                  >
                    {copied === "code" ? "Скопировано" : "Копировать код"}
                  </button>
                </div>
              </div>
            ) : null}

            {platform === "wordpress" ? (
              <div className="notify-steps" style={{ marginTop: 12 }}>
                <ol>
                  <li>Отдельного плагина CreoLab нет — используйте исходящий webhook формы.</li>
                  <li>
                    Для Contact Form 7: плагин вроде «CF7 to Webhook». Для WPForms / Gravity Forms — встроенный
                    Webhooks / Zapier-совместимый POST.
                  </li>
                  <li>Метод POST, адрес — этот же public endpoint. JSON или x-www-form-urlencoded.</li>
                  <li>
                    Поля: <code>name</code> и <code>phone</code> обязательны. Имена CF7 <code>your-name</code>,{" "}
                    <code>your-phone</code>, <code>your-email</code>, <code>your-message</code> тоже принимаются.
                  </li>
                  <li>Файлы (multipart) этот адрес не принимает. API-ключ CRM в сайт не вставляйте.</li>
                </ol>
                <div className="actions">
                  <button className="btn secondary" type="button" onClick={() => void markCopied("endpoint", endpoint)}>
                    {copied === "endpoint" ? "Скопировано" : "Копировать адрес"}
                  </button>
                </div>
              </div>
            ) : null}

            {platform === "api" ? (
              <div className="stack" style={{ marginTop: 12 }}>
                <p>
                  <b>HTTP method:</b> POST
                </p>
                <p>
                  <b>Endpoint:</b> {endpoint}
                </p>
                <p>
                  <b>Content-Type:</b> application/json или application/x-www-form-urlencoded
                </p>
                <p>
                  <b>Обязательные поля:</b> name, phone (номер Казахстана).
                </p>
                <p>
                  <b>Необязательные:</b> email, message, company, service / subject, comment, budget, deadline, city,
                  utm_source, utm_medium, utm_campaign, utm_content, utm_term, pageUrl, landingPage, referrer,
                  submission_id, is_test.
                </p>
                <p className="muted">
                  company_id и responsible_user_id в запросе игнорируются. Компания и ответственный берутся из
                  настроек этого подключения на сервере.
                </p>
                <pre className="code">{jsonExample(endpoint)}</pre>
                <p>
                  <b>Успех:</b> JSON <code>{`{ "ok": true, "receipt": "…", "duplicate": false }`}</code>. Для JSON
                  новых заявок — HTTP 202, для urlencoded (Tilda) и повторов — 200.
                </p>
                <p>
                  <b>Ошибки:</b> 404 форма недоступна; 403 компания приостановлена или интеграция отключена; 422 нет
                  имени или некорректный телефон (<code>field_errors</code>); 409 тот же ключ с другим телом; 429
                  слишком много запросов.
                </p>
                <p className="muted">
                  Антиспам: скрытое поле <code>website</code> принимается без создания заявки. Идемпотентность: заголовок{" "}
                  <code>X-Submission-Id</code> или поле <code>submission_id</code> / <code>tranid</code>.
                </p>
              </div>
            ) : null}
          </fieldset>

          <fieldset className="field-block">
            <legend>Поля формы</legend>
            <p className="muted">Какое поле с сайта куда попадёт в CRM этой компании.</p>
            <table className="form-map">
              <thead>
                <tr>
                  <th>Поле сайта</th>
                  <th>Поле CRM</th>
                </tr>
              </thead>
              <tbody>
                {mappingRows(existing.mapping).map((row) => (
                  <tr key={row.to}>
                    <td>
                      <code>{row.from}</code>
                    </td>
                    <td>
                      {row.to}
                      {row.required ? " · обязательно" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">Неизвестные поля сохраняются в заявке как дополнительные. Mapping задаётся этим подключением, не клиентским запросом.</p>
          </fieldset>

          <fieldset className="field-block">
            <legend>Проверка подключения</legend>
            <p className="muted">
              Тест идёт на тот же public endpoint и создаёт заявку в CRM компании {companyName}. Ответственный:{" "}
              {assigneeLabel}. Заявка будет помечена как тестовая.
            </p>
            <label>
              Имя
              <input value={testName} onChange={(event) => setTestName(event.target.value)} />
            </label>
            <label>
              Телефон
              <input value={testPhone} onChange={(event) => setTestPhone(event.target.value)} />
            </label>
            <label>
              Email
              <input value={testEmail} onChange={(event) => setTestEmail(event.target.value)} />
            </label>
            <div className="actions">
              <button className="btn" type="button" disabled={testBusy || !publicKey} onClick={() => void sendTest()}>
                {testBusy ? "Отправляем…" : "Отправить тестовую заявку"}
              </button>
            </div>
            {testOk ? (
              <div>
                <p className="ok">✓ Тестовая заявка получена</p>
                <p className="ok">✓ Подключение работает</p>
                <p className="muted">Проверьте заявку в CRM компании {companyName}.</p>
              </div>
            ) : null}
            {testError ? (
              <div>
                <p className="error">{testError}</p>
                {testDetail ? (
                  <p>
                    <button className="btn secondary" type="button" onClick={() => setShowTestDetail((open) => !open)}>
                      {showTestDetail ? "Скрыть" : "Подробнее"}
                    </button>
                  </p>
                ) : null}
                {showTestDetail && testDetail ? <pre className="code">{testDetail}</pre> : null}
              </div>
            ) : null}
          </fieldset>
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
