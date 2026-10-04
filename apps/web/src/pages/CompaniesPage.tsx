import { uiText, useUiText, localizeUiOptions, uiMessage } from "../lib/uiText";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { notifySaved } from "../components/SaveNotice";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useRequestVersion } from "../lib/useUrlState";

type Scope = "all" | "mine" | "unassigned";

const emptyDraft = () => ({
  name: "",
  legalName: "",
  bin: "",
  iin: "",
  legalAddress: "",
  directorName: "",
  iban: "",
  bankName: "",
  bik: "",
  industry: "",
  city: "",
  website: "",
  phone: "",
  email: "",
  description: "",
});

function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(uiText("Не удалось прочитать файл")));
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.readAsDataURL(file);
  });
}

export function CompaniesPage() {
  const uiText = useUiText();
  const navigate = useNavigate();
  const requestVersion = useRequestVersion();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<Scope>("all");
  const [q, setQ] = useState("");
  const [lifecycleStatus, setLifecycleStatus] = useState("");
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [duplicates, setDuplicates] = useState<any[]>([]);
  const [createBusy, setCreateBusy] = useState(false);
  const [parseBusy, setParseBusy] = useState(false);
  const [parseError, setParseError] = useState("");
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [requisitesText, setRequisitesText] = useState("");
  const [requisitesFile, setRequisitesFile] = useState<File | null>(null);
  const [draft, setDraft] = useState(emptyDraft);

  function closeCreate() {
    if (createBusy || parseBusy) return;
    setShowCreate(false);
    setDuplicates([]);
    setParseError("");
    setParseWarnings([]);
    setRequisitesText("");
    setRequisitesFile(null);
    setDraft(emptyDraft());
  }

  async function load() {
    const version = ++requestVersion.current;
    try {
      setLoading(true);
      const data: any = await api.companies({
        scope: scope === "all" ? undefined : scope,
        q: q.trim() || undefined,
        lifecycleStatus: lifecycleStatus || undefined,
      });
      if (version !== requestVersion.current) return;
      setItems(data.items || []);
      setError("");
    } catch (err) {
      if (version !== requestVersion.current) return;
      setError(err instanceof Error ? err.message : uiText("Ошибка"));
    } finally {
      if (version === requestVersion.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [scope, lifecycleStatus]);

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    await load();
  }

  async function parseRequisites(file = requisitesFile, text = requisitesText) {
    if (parseBusy || createBusy) return;
    if (!file && !text.trim()) {
      setParseError(uiText("Вставьте текст реквизитов или выберите PDF / Word"));
      return;
    }
    if (file && (file.size > 20 * 1024 * 1024 || !/\.(pdf|docx|doc)$/i.test(file.name))) {
      setParseError(uiText("Выберите PDF или Word (.docx, .doc) размером до 20 МБ"));
      return;
    }
    setParseBusy(true);
    setParseError("");
    setParseWarnings([]);
    try {
      const result: any = await api.parseCompanyRequisites(
        text.trim()
          ? { text: text.trim() }
          : { fileName: file!.name, fileBase64: await readBase64(file!) },
      );
      const parsed = result.draft || {};
      setDraft((current) => ({
        ...current,
        name: parsed.name || current.name,
        legalName: parsed.legalName || parsed.name || current.legalName,
        bin: parsed.bin || parsed.iin || current.bin,
        iin: parsed.iin || current.iin,
        legalAddress: parsed.legalAddress || current.legalAddress,
        directorName: parsed.directorName || current.directorName,
        iban: parsed.iban || current.iban,
        bankName: parsed.bankName || current.bankName,
        bik: parsed.bik || current.bik,
        city: parsed.city || current.city,
        phone: parsed.phone || current.phone,
        email: parsed.email || current.email,
      }));
      setParseWarnings(Array.isArray(result.warnings) ? result.warnings : []);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : uiText("Не удалось распознать реквизиты"));
    } finally {
      setParseBusy(false);
    }
  }

  async function onPickFile(file: File | null) {
    setRequisitesFile(file);
    setParseError("");
    if (file) await parseRequisites(file, "");
  }

  async function createCompany(force = false) {
    setCreateBusy(true);
    try {
      const created: any = await api.createCompany({
        ...draft,
        bin: draft.bin || undefined,
        iin: draft.iin || undefined,
        forceCreate: force || undefined,
      });
      setShowCreate(false);
      setDuplicates([]);
      setParseError("");
      setParseWarnings([]);
      setRequisitesText("");
      setRequisitesFile(null);
      setDraft(emptyDraft());
      notifySaved(uiText("Компания создана"));
      navigate(`/companies/${created.id}`);
    } catch (err: any) {
      if (err?.status === 409) {
        const details = err.body?.details || err.body;
        setDuplicates(details?.duplicates || []);
        if (!details?.duplicates?.length) {
          try {
            const dup: any = await api.companyDuplicates({
              name: draft.name,
              bin: draft.bin || undefined,
              website: draft.website || undefined,
              email: draft.email || undefined,
              phone: draft.phone || undefined,
            });
            setDuplicates(dup.duplicates || []);
          } catch {
            setError(err instanceof Error ? err.message : uiText("Ошибка создания"));
          }
        }
      } else {
        setError(err instanceof Error ? err.message : uiText("Ошибка создания"));
      }
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <section className="companies-page">
      <div className="row sit-head">
        <div>
          <h2>{uiText("Компании")}</h2>
          <p className="muted">{uiText("Организации, с которыми вы работаете.")}</p>
        </div>
        <button type="button" className="btn" onClick={() => setShowCreate(true)}>
          {uiText("+ Компания")}</button>
      </div>

      <div className="sit-toolbar">
        <div className="sit-periods">
          {(
            [
              ["all", uiText("Все")],
              ["mine", uiText("Мои")],
              ["unassigned", uiText("Без ответственного")],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={scope === id ? "btn sit-chip" : "btn secondary sit-chip"}
              onClick={() => setScope(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <form className="companies-search" onSubmit={onSearch}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={uiText("Название, БИН, контакт, телефон…")}
          />
          <select value={lifecycleStatus} onChange={(e) => setLifecycleStatus(e.target.value)}>
            <option value="">{uiText("Все статусы")}</option>
            <option value="PROSPECT">{uiText("Потенциальный клиент")}</option>
            <option value="CUSTOMER">{uiText("Клиент")}</option>
            <option value="INACTIVE_CUSTOMER">{uiText("Неактивный")}</option>
            <option value="PARTNER">{uiText("Партнёр")}</option>
            <option value="ARCHIVED">{uiText("Архив")}</option>
          </select>
          <button type="submit" className="btn secondary">
            {uiText("Найти")}</button>
        </form>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {loading ? <div className="state">{uiText("Загрузка…")}</div> : null}

      {!loading && !items.length ? (
        <div className="sit-section">
          <p className="empty">{uiText("Пока нет компаний. Клиентов без организации можно вести в разделе «Клиенты».")}</p>
        </div>
      ) : null}

      <div className="companies-list">
        {items.map((item) => (
          <Link key={item.id} to={`/companies/${item.id}`} className="company-row">
            <div>
              <b>{item.name}</b>
              <div className="muted">
                {[uiMessage(item.lifecycleLabel), item.industry, item.city].filter(Boolean).join(" · ")}
              </div>
              {item.primaryContact ? (
                <div className="muted">
                  {uiText("Основной контакт:")}{" "}{item.primaryContact.name}
                  {item.primaryContact.position ? ` · ${item.primaryContact.position}` : ""}
                </div>
              ) : null}
            </div>
            <div className="company-row-meta">
              <div>{uiText("Контактов:")}{" "}{item.contactsCount}</div>
              <div>{uiText("Активных сделок:")}{" "}{item.activeDealsCount}</div>
              <div>{uiText("Сумма сделки:")}{" "}{item.pipelineLabel || "—"}</div>
              <div className="muted">{item.lastActivityLabel || uiText("Нет активности")}</div>
              <div className="muted">{item.assigneeName || uiText("Без ответственного")}</div>
            </div>
          </Link>
        ))}
      </div>

      {showCreate ? (
        <div className="stats-modal-backdrop" onClick={closeCreate}>
          <div className="stats-modal company-create-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{uiText("Новая компания")}</h3>
            <div className="company-requisites">
              <b>{uiText("Из реквизитов")}</b>
              <p className="muted">{uiText("PDF, Word или вставьте текст — распознаем название, БИН, адрес и банк.")}</p>
              <div className="company-requisites-actions">
                <input
                  ref={fileInputRef}
                  type="file"
                  hidden
                  accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={(e) => void onPickFile(e.target.files?.[0] || null)}
                />
                <button
                  type="button"
                  className="btn secondary"
                  disabled={parseBusy || createBusy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  {requisitesFile ? requisitesFile.name : uiText("Загрузить PDF / Word")}
                </button>
                {requisitesFile ? (
                  <button
                    type="button"
                    className="btn secondary"
                    disabled={parseBusy || createBusy}
                    onClick={() => {
                      setRequisitesFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                  >
                    {uiText("Убрать файл")}</button>
                ) : null}
              </div>
              <textarea
                value={requisitesText}
                onChange={(e) => setRequisitesText(e.target.value)}
                rows={4}
                placeholder={uiText("Вставьте реквизиты компании…")}
              />
              <button
                type="button"
                className="btn secondary"
                disabled={parseBusy || createBusy}
                onClick={() => void parseRequisites()}
              >
                {parseBusy ? uiText("Распознаём…") : uiText("Распознать")}
              </button>
              {parseError ? <p className="error">{parseError}</p> : null}
              {parseWarnings.length ? (
                <ul className="company-requisites-warnings">
                  {parseWarnings.map((warning) => (
                    <li key={warning}>{uiMessage(warning)}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="company-create-grid">
              <label className="span-2">
                {uiText("Название *")}<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label className="span-2">
                {uiText("Юридическое название")}<input value={draft.legalName} onChange={(e) => setDraft({ ...draft, legalName: e.target.value })} />
              </label>
              <label>
                {uiText("БИН / ИИН")}<input value={draft.bin} onChange={(e) => setDraft({ ...draft, bin: e.target.value })} />
              </label>
              <label>
                {uiText("Город")}<input value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} />
              </label>
              <label className="span-2">
                {uiText("Юридический адрес")}<input
                  value={draft.legalAddress}
                  onChange={(e) => setDraft({ ...draft, legalAddress: e.target.value })}
                />
              </label>
              <label>
                {uiText("Директор")}<input
                  value={draft.directorName}
                  onChange={(e) => setDraft({ ...draft, directorName: e.target.value })}
                />
              </label>
              <label>
                {uiText("Банк")}<input value={draft.bankName} onChange={(e) => setDraft({ ...draft, bankName: e.target.value })} />
              </label>
              <label>
                {uiText("ИИК / IBAN")}<input value={draft.iban} onChange={(e) => setDraft({ ...draft, iban: e.target.value })} />
              </label>
              <label>
                {uiText("БИК")}<input value={draft.bik} onChange={(e) => setDraft({ ...draft, bik: e.target.value })} />
              </label>
              <label>
                {uiText("Отрасль")}<input value={draft.industry} onChange={(e) => setDraft({ ...draft, industry: e.target.value })} />
              </label>
              <label>
                {uiText("Телефон")}<input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
              </label>
              <label>
                Email
                <input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
              </label>
              <label className="span-2">
                {uiText("Сайт")}<input value={draft.website} onChange={(e) => setDraft({ ...draft, website: e.target.value })} />
              </label>
              <label className="span-2">
                {uiText("Комментарий")}<textarea
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  rows={3}
                />
              </label>
            </div>
            {duplicates.length ? (
              <div className="sit-section" style={{ marginTop: 12 }}>
                <b>{uiText("Возможно, компания уже существует")}</b>
                {duplicates.map((d) => (
                  <div key={d.id} className="row" style={{ marginTop: 8 }}>
                    <div>
                      <div>{d.name}</div>
                      <div className="muted">
                        {[d.bin ? uiText("БИН {p0}", {p0: d.bin}) : null, uiText("{p0} контактов", {p0: d.contactsCount}), uiText("{p0} сделок", {p0: d.activeDealsCount})]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <Link className="btn secondary" to={`/companies/${d.id}`}>
                      {uiText("Открыть")}</Link>
                  </div>
                ))}
                <button type="button" className="btn secondary" style={{ marginTop: 8 }} onClick={() => void createCompany(true)}>
                  {uiText("Всё равно создать")}</button>
              </div>
            ) : null}
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button type="button" className="btn" disabled={createBusy || parseBusy || !draft.name.trim()} onClick={() => void createCompany(false)}>
                {uiText("Создать")}</button>
              <button type="button" className="btn secondary" disabled={createBusy || parseBusy} onClick={closeCreate}>
                {uiText("Отмена")}</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
