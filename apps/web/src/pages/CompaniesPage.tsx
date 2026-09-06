import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

type Scope = "all" | "mine" | "unassigned";

export function CompaniesPage() {
  const [scope, setScope] = useState<Scope>("all");
  const [q, setQ] = useState("");
  const [lifecycleStatus, setLifecycleStatus] = useState("");
  const [items, setItems] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [duplicates, setDuplicates] = useState<any[]>([]);
  const [createBusy, setCreateBusy] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    legalName: "",
    bin: "",
    industry: "",
    city: "",
    website: "",
    phone: "",
    email: "",
    description: "",
  });

  async function load() {
    try {
      setLoading(true);
      const data: any = await api.companies({
        scope: scope === "all" ? undefined : scope,
        q: q.trim() || undefined,
        lifecycleStatus: lifecycleStatus || undefined,
      });
      setItems(data.items || []);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [scope, lifecycleStatus]);

  async function onSearch(e: FormEvent) {
    e.preventDefault();
    await load();
  }

  async function createCompany(force = false) {
    setCreateBusy(true);
    try {
      const created: any = await api.createCompany({ ...draft, forceCreate: force || undefined });
      setShowCreate(false);
      setDuplicates([]);
      setDraft({
        name: "",
        legalName: "",
        bin: "",
        industry: "",
        city: "",
        website: "",
        phone: "",
        email: "",
        description: "",
      });
      window.location.href = `/companies/${created.id}`;
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
            setError(err instanceof Error ? err.message : "Ошибка создания");
          }
        }
      } else {
        setError(err instanceof Error ? err.message : "Ошибка создания");
      }
    } finally {
      setCreateBusy(false);
    }
  }

  return (
    <section className="companies-page">
      <div className="row sit-head">
        <div>
          <h2>Компании</h2>
          <p className="muted">Организации и общая история отношений</p>
        </div>
        <button type="button" className="btn" onClick={() => setShowCreate(true)}>
          + Компания
        </button>
      </div>

      <div className="sit-toolbar">
        <div className="sit-periods">
          {(
            [
              ["all", "Все доступные"],
              ["mine", "Мои"],
              ["unassigned", "Без ответственного"],
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
            placeholder="Название, БИН, контакт, телефон…"
          />
          <select value={lifecycleStatus} onChange={(e) => setLifecycleStatus(e.target.value)}>
            <option value="">Все статусы</option>
            <option value="PROSPECT">Потенциальный клиент</option>
            <option value="CUSTOMER">Клиент</option>
            <option value="INACTIVE_CUSTOMER">Неактивный</option>
            <option value="PARTNER">Партнёр</option>
            <option value="ARCHIVED">Архив</option>
          </select>
          <button type="submit" className="btn secondary">
            Найти
          </button>
        </form>
      </div>

      {error ? <p className="error">{error}</p> : null}
      {loading ? <div className="state">Загрузка…</div> : null}

      {!loading && !items.length ? (
        <div className="sit-section">
          <p className="empty">Пока нет компаний. B2C-клиенты продолжают работать без организации.</p>
        </div>
      ) : null}

      <div className="companies-list">
        {items.map((item) => (
          <Link key={item.id} to={`/companies/${item.id}`} className="company-row">
            <div>
              <b>{item.name}</b>
              <div className="muted">
                {[item.lifecycleLabel, item.industry, item.city].filter(Boolean).join(" · ")}
              </div>
              {item.primaryContact ? (
                <div className="muted">
                  Основной контакт: {item.primaryContact.name}
                  {item.primaryContact.position ? ` · ${item.primaryContact.position}` : ""}
                </div>
              ) : null}
            </div>
            <div className="company-row-meta">
              <div>Контактов: {item.contactsCount}</div>
              <div>Активных сделок: {item.activeDealsCount}</div>
              <div>Pipeline: {item.pipelineLabel || "—"}</div>
              <div className="muted">{item.lastActivityLabel || "Нет активности"}</div>
              <div className="muted">{item.assigneeName || "Без ответственного"}</div>
            </div>
          </Link>
        ))}
      </div>

      {showCreate ? (
        <div className="stats-modal-backdrop" onClick={() => setShowCreate(false)}>
          <div className="stats-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Новая компания</h3>
            <div className="stats-filters" style={{ gridTemplateColumns: "1fr" }}>
              <label>
                Название *
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <label>
                Юридическое название
                <input value={draft.legalName} onChange={(e) => setDraft({ ...draft, legalName: e.target.value })} />
              </label>
              <label>
                БИН
                <input value={draft.bin} onChange={(e) => setDraft({ ...draft, bin: e.target.value })} />
              </label>
              <label>
                Отрасль
                <input value={draft.industry} onChange={(e) => setDraft({ ...draft, industry: e.target.value })} />
              </label>
              <label>
                Город
                <input value={draft.city} onChange={(e) => setDraft({ ...draft, city: e.target.value })} />
              </label>
              <label>
                Сайт
                <input value={draft.website} onChange={(e) => setDraft({ ...draft, website: e.target.value })} />
              </label>
              <label>
                Телефон
                <input value={draft.phone} onChange={(e) => setDraft({ ...draft, phone: e.target.value })} />
              </label>
              <label>
                Email
                <input value={draft.email} onChange={(e) => setDraft({ ...draft, email: e.target.value })} />
              </label>
              <label>
                Комментарий
                <textarea
                  value={draft.description}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  rows={3}
                />
              </label>
            </div>
            {duplicates.length ? (
              <div className="sit-section" style={{ marginTop: 12 }}>
                <b>Возможно, компания уже существует</b>
                {duplicates.map((d) => (
                  <div key={d.id} className="row" style={{ marginTop: 8 }}>
                    <div>
                      <div>{d.name}</div>
                      <div className="muted">
                        {[d.bin ? `БИН ${d.bin}` : null, `${d.contactsCount} контактов`, `${d.activeDealsCount} сделок`]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <Link className="btn secondary" to={`/companies/${d.id}`}>
                      Открыть
                    </Link>
                  </div>
                ))}
                <button type="button" className="btn secondary" style={{ marginTop: 8 }} onClick={() => void createCompany(true)}>
                  Всё равно создать
                </button>
              </div>
            ) : null}
            <div className="row" style={{ gap: 8, marginTop: 12 }}>
              <button type="button" className="btn" disabled={createBusy || !draft.name.trim()} onClick={() => void createCompany(false)}>
                Создать
              </button>
              <button type="button" className="btn secondary" onClick={() => setShowCreate(false)}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
