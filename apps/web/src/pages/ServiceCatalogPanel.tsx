import { useEffect, useState, type FormEvent } from "react";
import { api } from "../lib/api";
import type { TenantService } from "../lib/tenantServices";

export function ServiceCatalogPanel() {
  const [items, setItems] = useState<TenantService[]>([]);
  const [editing, setEditing] = useState<TenantService | null>(null);
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<TenantService["kind"]>("SERVICE");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [aliases, setAliases] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  async function load() {
    const result = await api.request<{ items: TenantService[] }>("/api/v1/service-categories");
    setItems(result.items);
  }
  useEffect(() => { load().catch((err) => setError(err instanceof Error ? err.message : "Не удалось загрузить справочник")).finally(() => setLoading(false)); }, []);
  function edit(item: TenantService | null) {
    setKind(item?.kind || "SERVICE"); setEditing(item); setCreating(!item); setName(item?.name || ""); setDescription(item?.description || ""); setAliases(item?.aliases.join(", ") || ""); setError(""); setNotice("");
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api.request(`/api/v1/service-categories${editing ? `/${encodeURIComponent(editing.code)}` : ""}`, { method: editing ? "PATCH" : "POST", body: JSON.stringify({ kind, name, description, aliases: aliases.split(",").map((text) => text.trim()).filter(Boolean), active: editing?.active ?? true }) });
      await load(); setCreating(false); setEditing(null); setNotice("Позиция сохранена.");
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось сохранить позицию"); }
    finally { setBusy(false); }
  }
  async function toggle(item: TenantService) {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try {
      const { code, ...data } = item;
      await api.request(`/api/v1/service-categories/${encodeURIComponent(code)}`, { method: "PATCH", body: JSON.stringify({ ...data, active: !item.active }) });
      await load(); setNotice(item.active ? "Позиция в архиве. В старых заявках она сохранена." : "Позиция снова доступна для новых заявок.");
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось изменить позицию"); }
    finally { setBusy(false); }
  }
  return <section className="panel stack service-catalog-panel">
    <div className="page-head"><h3>Услуги и товары</h3><button className="btn" type="button" disabled={busy || loading || creating || Boolean(editing)} onClick={() => edit(null)}>Добавить позицию</button></div>
    <p className="muted">Этот справочник виден только вашей компании. Его используют заявки, фильтр «Услуга / товар» и AI при определении потребности клиента.</p>
    {error ? <p className="error" role="alert">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {creating || editing ? <form className="stack service-catalog-form" onSubmit={save}>
      <h4>{editing ? "Изменить позицию" : "Новая позиция"}</h4>
      <label>Тип позиции<select value={kind} onChange={(event) => setKind(event.target.value as TenantService["kind"])}><option value="SERVICE">Услуга</option><option value="PRODUCT">Товар</option></select></label>
      <label>Название<input required maxLength={80} value={name} onChange={(event) => setName(event.target.value)} placeholder={kind === "PRODUCT" ? "Например: Моторное масло 5W-30" : "Например: Диагностика автомобиля"} /></label>
      <label>Описание<textarea maxLength={1000} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Краткое описание для сотрудников и AI" /></label>
      <label>Как называют клиенты<input value={aliases} onChange={(event) => setAliases(event.target.value)} placeholder="Варианты названия через запятую" /></label>
      <p className="muted">Укажите синонимы и привычные формулировки. Если подходящей позиции нет или выбор неоднозначен, заявка останется с пометкой «Не определено».</p>
      <div className="actions"><button className="btn" disabled={busy} type="submit">Сохранить позицию</button><button className="btn secondary" disabled={busy} type="button" onClick={() => { setCreating(false); setEditing(null); }}>Отмена</button></div>
    </form> : null}
    {loading ? <p className="muted">Загружаем справочник…</p> : !items.length && !error ? <p>Справочник пока пуст. Добавьте услуги, которые оказывает ваша компания, и товары, которые она продаёт.</p> : null}
    {([true, false] as const).map((active) => {
      const rows = items.filter((item) => item.active === active);
      return rows.length ? <section key={String(active)} className="stack"><h4>{active ? "Активные услуги и товары" : "Архив"}</h4>{rows.map((item) => <article key={item.code} className="service-catalog-row"><div><b>{item.name}</b> <span className="badge">{item.kind === "PRODUCT" ? "Товар" : "Услуга"}</span>{item.description ? <p className="muted">{item.description}</p> : null}{item.aliases.length ? <small className="muted">Также: {item.aliases.join(", ")}</small> : null}</div><div className="actions"><button className="btn secondary" type="button" disabled={busy || creating || Boolean(editing)} onClick={() => edit(item)}>Изменить</button><button className="btn secondary" type="button" disabled={busy || creating || Boolean(editing)} onClick={() => void toggle(item)}>{active ? "В архив" : "Восстановить"}</button></div></article>)}</section> : null;
    })}
    <p className="muted">Архивные позиции остаются в старых заявках и фильтрах. Для новых заявок и AI они недоступны. Переименование обновит название и в старых заявках.</p>
  </section>;
}
