import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { notifySaved } from "../components/SaveNotice";
import {
  ContractGenerateItems,
  newContractDraftLine,
  parseContractDraftLines,
  type ContractDraftLine,
} from "../components/ContractGenerateItems";

type TemplateRow = {
  id: string;
  name: string;
  isDefault: boolean;
  fromWord?: boolean;
  placeholders: string[];
  preview: string;
};

type Preview = {
  name: string;
  body: string;
  placeholders: string[];
  seller: { name: string; bin: string };
  buyer: { name: string; bin: string };
  warnings: string[];
};

function readBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.readAsDataURL(file);
  });
}

export function ContractTemplatePanel() {
  const navigate = useNavigate();
  const [items, setItems] = useState<TemplateRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState("");
  const [companies, setCompanies] = useState<Array<{ id: string; name: string }>>([]);
  const [companyId, setCompanyId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [formBusy, setFormBusy] = useState(false);
  const [lines, setLines] = useState<ContractDraftLine[]>([newContractDraftLine()]);

  async function loadTemplates() {
    try {
      const data: any = await api.contractTemplates();
      const list = data.items || [];
      setItems(list);
      const nextId = templateId || list.find((row: TemplateRow) => row.isDefault)?.id || list[0]?.id || "";
      if (!templateId && nextId) setTemplateId(nextId);
      setLines((current) => {
        if (current.length !== 1 || current[0].name.trim()) return current;
        const chosen = list.find((row: TemplateRow) => row.id === nextId);
        return [{ ...current[0], name: chosen?.name || "" }];
      });
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить шаблоны");
    }
  }

  useEffect(() => {
    void loadTemplates();
    void api
      .companies({})
      .then((data: any) => setCompanies(data.items || []))
      .catch(() => setCompanies([]));
  }, []);

  async function recognize() {
    if (busy || !file) return;
    if (!/\.(docx|doc)$/i.test(file.name) || file.size > 20 * 1024 * 1024) {
      setError("Выберите Word (.docx или .doc) размером до 20 МБ");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const scanned: any = await api.previewContractTemplate({
        fileName: file.name,
        fileBase64: await readBase64(file),
      });
      setPreview(scanned);
      setName(scanned.name || file.name.replace(/\.[^.]+$/, ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось распознать шаблон");
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (busy || !preview || !name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api.createContractTemplate({
        name: name.trim(),
        body: preview.body,
        isDefault: true,
        fileName: file?.name,
        fileBase64: file ? await readBase64(file) : undefined,
      });
      notifySaved("Шаблон договора сохранён");
      setOpen(false);
      setFile(null);
      setPreview(null);
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить шаблон");
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault(id: string) {
    setBusy(true);
    try {
      await api.updateContractTemplate(id, { isDefault: true });
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось выбрать шаблон");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Удалить этот шаблон договора?")) return;
    setBusy(true);
    try {
      await api.deleteContractTemplate(id);
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось удалить шаблон");
    } finally {
      setBusy(false);
    }
  }

  async function generateForCompany() {
    if (!companyId || !templateId || formBusy) return;
    let items;
    try {
      items = parseContractDraftLines(lines);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Проверьте услуги");
      return;
    }
    setFormBusy(true);
    setError("");
    try {
      const result: any = await api.createCompanyContractFromTemplate(companyId, { templateId, items });
      notifySaved(result.generated ? "Договор сформирован по шаблону" : "Черновик договора создан");
      if (result.dealId) navigate(`/deals/${result.dealId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сформировать договор");
    } finally {
      setFormBusy(false);
    }
  }

  return (
    <div className="panel manual-pdf-import">
      <div className="saved-editor-summary">
        <div>
          <b>Шаблоны договоров</b>
          <p className="muted">
            Загрузите договор в Word — PDF соберётся из этого файла: все пункты, приложения и реквизиты останутся как в шаблоне, подставятся только стороны, номер, дата и сумма.
          </p>
        </div>
        {!open ? (
          <button type="button" className="btn" onClick={() => { setOpen(true); setError(""); setPreview(null); setFile(null); }}>
            Загрузить шаблон
          </button>
        ) : null}
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      {open ? (
        <div className="stack">
          {!preview ? (
            <>
              <label>
                Файл шаблона (DOCX, DOC)
                <input
                  type="file"
                  accept=".docx,.doc,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  disabled={busy}
                  onChange={(e) => { setFile(e.target.files?.[0] || null); setError(""); }}
                />
              </label>
              <p className="muted">До 20 МБ. Реквизиты исполнителя и заказчика заменяются на поля шаблона, текст услуги сохраняется.</p>
              <div className="actions">
                <button type="button" className="btn" disabled={busy || !file} onClick={() => void recognize()}>
                  {busy ? "Распознаём…" : "Распознать шаблон"}
                </button>
                <button type="button" className="btn secondary" disabled={busy} onClick={() => { setOpen(false); setPreview(null); setFile(null); }}>
                  Отмена
                </button>
              </div>
            </>
          ) : (
            <>
              <label>
                Название шаблона
                <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
              </label>
              <p className="muted">
                Исполнитель: {preview.seller.name || "—"}{preview.seller.bin ? ` · БИН ${preview.seller.bin}` : ""}
                {" · "}
                Заказчик: {preview.buyer.name || "—"}{preview.buyer.bin ? ` · БИН ${preview.buyer.bin}` : ""}
              </p>
              <p className="muted">Поля: {preview.placeholders.join(", ") || "не найдены"}</p>
              {preview.warnings.length ? (
                <ul className="pdf-import-warnings">
                  {preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              ) : null}
              <pre className="contract-template-preview">{preview.body.slice(0, 1600)}{preview.body.length > 1600 ? "…" : ""}</pre>
              <div className="actions">
                <button type="button" className="btn" disabled={busy || !name.trim()} onClick={() => void save()}>
                  {busy ? "Сохраняем…" : "Сохранить шаблон"}
                </button>
                <button type="button" className="btn secondary" disabled={busy} onClick={() => setPreview(null)}>
                  Другой файл
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {items.length ? (
        <div className="stack" style={{ marginTop: 12 }}>
          {items.map((row) => (
            <div className="row" key={row.id}>
              <div>
                <b>{row.name}</b>
                {row.isDefault ? <span className="muted"> · по умолчанию</span> : null}
                {row.fromWord ? <span className="muted"> · Word</span> : null}
                <div className="muted">{row.placeholders.slice(0, 8).join(", ")}</div>
              </div>
              <div className="actions">
                {!row.isDefault ? (
                  <button type="button" className="btn secondary" disabled={busy} onClick={() => void makeDefault(row.id)}>
                    По умолчанию
                  </button>
                ) : null}
                <button type="button" className="btn secondary" disabled={busy} onClick={() => void remove(row.id)}>
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {items.length ? (
        <div className="stack" style={{ marginTop: 12 }}>
          <b>Сформировать договор по шаблону</b>
          <p className="muted">После загрузки реквизитов компании выберите шаблон Word — договор повторит его текст, а не короткую форму CRM.</p>
          <label>
            Компания
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">Выберите компанию</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>{company.name}</option>
              ))}
            </select>
          </label>
          <label>
            Шаблон
            <select
              value={templateId}
              onChange={(e) => {
                const id = e.target.value;
                const previous = items.find((row) => row.id === templateId)?.name || "";
                setTemplateId(id);
                const nextName = items.find((row) => row.id === id)?.name || "";
                setLines((current) => {
                  if (current.length === 1 && (!current[0].name.trim() || current[0].name === previous)) {
                    return [{ ...current[0], name: nextName }];
                  }
                  return current;
                });
              }}
            >
              {items.map((row) => (
                <option key={row.id} value={row.id}>{row.name}{row.isDefault ? " (по умолчанию)" : ""}</option>
              ))}
            </select>
          </label>
          <ContractGenerateItems lines={lines} onChange={setLines} disabled={formBusy} />
          <div className="actions">
            <button type="button" className="btn" disabled={formBusy || !companyId || !templateId} onClick={() => void generateForCompany()}>
              {formBusy ? "Формируем…" : "Сформировать по шаблону"}
            </button>
            {companyId ? <Link className="btn secondary" to={`/companies/${companyId}`}>Карточка компании</Link> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
