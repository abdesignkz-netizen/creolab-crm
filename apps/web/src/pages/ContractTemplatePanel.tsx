import { useEffect, useRef, useState } from "react";
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
  const [savedNotice, setSavedNotice] = useState("");
  const [justSavedId, setJustSavedId] = useState("");
  const [renameId, setRenameId] = useState("");
  const [renameValue, setRenameValue] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  function closeUpload() {
    setOpen(false);
    setFile(null);
    setPreview(null);
    setBusy(false);
  }

  function openUpload() {
    setOpen(true);
    setError("");
    setSavedNotice("");
    setFile(null);
    setPreview(null);
    setName("");
  }

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
      window.setTimeout(() => {
        nameRef.current?.focus();
        nameRef.current?.select();
      }, 0);
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
      const created: any = await api.createContractTemplate({
        name: name.trim(),
        body: preview.body,
        isDefault: true,
        fileName: file?.name,
        fileBase64: file ? await readBase64(file) : undefined,
      });
      const saved = created.template;
      const title = saved?.name || name.trim();
      notifySaved(`Шаблон «${title}» сохранён`);
      setSavedNotice(`Шаблон «${title}» сохранён. Он в списке ниже и выбран для формирования договора.`);
      setJustSavedId(saved?.id || "");
      if (saved?.id) setTemplateId(saved.id);
      closeUpload();
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

  async function saveRename() {
    if (busy || !renameId || !renameValue.trim()) return;
    setBusy(true);
    setError("");
    try {
      const title = renameValue.trim();
      await api.updateContractTemplate(renameId, { name: title });
      notifySaved(`Шаблон переименован в «${title}»`);
      setSavedNotice(`Шаблон теперь называется «${title}».`);
      setJustSavedId(renameId);
      setRenameId("");
      await loadTemplates();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось переименовать шаблон");
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
        <button
          type="button"
          className={open ? "btn secondary" : "btn"}
          disabled={busy}
          onClick={() => (open ? closeUpload() : openUpload())}
        >
          {open ? "Закрыть" : "Загрузить шаблон"}
        </button>
      </div>
      {savedNotice ? <p className="ok" role="status">{savedNotice}</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {open ? (
        <div className="contract-template-upload" role="region" aria-label="Загрузка шаблона договора">
          {!preview ? (
            <>
              <label>
                Файл шаблона (DOCX, DOC)
                <input
                  type="file"
                  accept=".docx,.doc,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  disabled={busy}
                  onChange={(e) => { setFile(e.target.files?.[0] || null); setError(""); setSavedNotice(""); }}
                />
              </label>
              <p className="muted">До 20 МБ. После распознавания можно задать своё название и сохранить шаблон в список.</p>
              <div className="actions">
                <button type="button" className="btn" disabled={busy || !file} onClick={() => void recognize()}>
                  {busy ? "Распознаём…" : "Распознать шаблон"}
                </button>
                <button type="button" className="btn secondary" disabled={busy} onClick={closeUpload}>
                  Закрыть
                </button>
              </div>
            </>
          ) : (
            <>
              <label>
                Название шаблона
                <input
                  ref={nameRef}
                  value={name}
                  maxLength={200}
                  placeholder="Например: Договор на презентацию"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <p className="muted">Так шаблон будет называться в списке. Предложенное имя можно заменить на своё.</p>
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
              <p className="muted">Полный текст шаблона — прокрутите, чтобы увидеть все пункты. Сохраняется целиком, не только то, что видно в окне.</p>
              <pre className="contract-template-preview">{preview.body}</pre>
              <div className="actions">
                <button type="button" className="btn" disabled={busy || !name.trim()} onClick={() => void save()}>
                  {busy ? "Сохраняем…" : name.trim() ? `Сохранить как «${name.trim()}»` : "Сохранить шаблон"}
                </button>
                <button type="button" className="btn secondary" disabled={busy} onClick={() => { setPreview(null); setFile(null); }}>
                  Другой файл
                </button>
                <button type="button" className="btn secondary" disabled={busy} onClick={closeUpload}>
                  Закрыть
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {items.length ? (
        <div className="stack" style={{ marginTop: 12 }}>
          {items.map((row) => (
            <div className={`row${row.id === justSavedId ? " contract-template-saved-row" : ""}`} key={row.id}>
              <div>
                {renameId === row.id ? (
                  <label>
                    Новое название
                    <input
                      value={renameValue}
                      maxLength={200}
                      autoFocus
                      onChange={(e) => setRenameValue(e.target.value)}
                    />
                  </label>
                ) : (
                  <>
                    <b>{row.name}</b>
                    {row.id === justSavedId ? <span className="muted"> · только что сохранён</span> : null}
                    {row.isDefault ? <span className="muted"> · по умолчанию</span> : null}
                    {row.fromWord ? <span className="muted"> · Word</span> : null}
                    <div className="muted">{row.placeholders.slice(0, 8).join(", ")}</div>
                  </>
                )}
              </div>
              <div className="actions">
                {renameId === row.id ? (
                  <>
                    <button type="button" className="btn" disabled={busy || !renameValue.trim()} onClick={() => void saveRename()}>
                      Сохранить имя
                    </button>
                    <button type="button" className="btn secondary" disabled={busy} onClick={() => setRenameId("")}>
                      Отмена
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busy}
                      onClick={() => { setRenameId(row.id); setRenameValue(row.name); }}
                    >
                      Переименовать
                    </button>
                    {!row.isDefault ? (
                      <button type="button" className="btn secondary" disabled={busy} onClick={() => void makeDefault(row.id)}>
                        По умолчанию
                      </button>
                    ) : null}
                    <button type="button" className="btn secondary" disabled={busy} onClick={() => void remove(row.id)}>
                      Удалить
                    </button>
                  </>
                )}
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
