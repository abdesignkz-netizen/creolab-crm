import { InlineFeedback } from "../../components/InlineFeedback";
import { uiMessage, uiText, useUiText, localizeUiOptions } from "../../lib/uiText";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { notifySaved } from "../../components/SaveNotice";
import { formatDateTime } from "../../lib/datetime";
import { statusBadgeClass } from "../../lib/statusBadge";

type KnowledgeItem = {
  id: string;
  title: string;
  content: string;
  sourceType: string;
  status: string;
};

type ActivationPiece = {
  ready?: boolean;
  live?: boolean;
  label?: string;
  reason?: string;
};

type Activation = {
  whatsappConnected?: boolean;
  prompt?: ActivationPiece;
  knowledge?: ActivationPiece;
  syncedAt?: string | null;
  note?: string;
};

export function PlatformCompanyAiManager({ tenantId }: { tenantId: string }) {
  const uiText = useUiText();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState("");

  async function load() {
    setData(await api.adminCompanyAiManager(tenantId));
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : uiText("Ошибка")));
  }, [tenantId]);

  if (error) return <InlineFeedback kind="error" className="error">{error}</InlineFeedback>;
  if (!data) return <div className="state">{uiText("Загрузка…")}</div>;

  const promptText = String(data.prompt?.published || data.prompt?.draft || "");
  const activation = (data.activation || {}) as Activation;
  const promptState = activation.prompt || {};
  const knowledgeState = activation.knowledge || {};
  const whatsappLabel = activation.whatsappConnected ? uiText("Подключён") : uiText("Не подключён");

  async function sendToWhatsApp() {
    setSyncBusy(true);
    setSyncError("");
    try {
      const result = (await api.adminSyncCompanyAiManager(tenantId)) as { activation?: Activation };
      const next = result.activation || {};
      const live = Boolean(next.prompt?.live && next.knowledge?.live);
      notifySaved(live ? uiText("Промт и база активны в WhatsApp") : uiText("Отправлено, но в WhatsApp пока не активно"));
      await load();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : uiText("Не удалось отправить в WhatsApp"));
    } finally {
      setSyncBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="panel stack">
        <p>
          {uiText("QR-код, Green API и официальный WhatsApp используют промпт и базу знаний выбранной компании. Настройте ИИ отдельно от подключения номера.")}</p>
        <div className="ai-activation">
          <p className="integ-status-line">
            {uiText("Промт")}<span className={statusBadgeClass(promptState.label || "Не задан")}>{uiMessage(promptState.label) || uiText("Не задан")}</span>
          </p>
          {promptState.reason ? <p className="muted">{uiMessage(promptState.reason)}</p> : null}
          <p className="integ-status-line">
            {uiText("База знаний")}<span className={statusBadgeClass(knowledgeState.label || "Не задана")}>
              {uiMessage(knowledgeState.label) || uiText("Не задана")}
            </span>
          </p>
          {knowledgeState.reason ? <p className="muted">{uiMessage(knowledgeState.reason)}</p> : null}
          <p className="integ-status-line">
            WhatsApp
            <span className={statusBadgeClass(whatsappLabel)}>{whatsappLabel}</span>
          </p>
          <p className="muted">
            {uiText("Материалов в базе:")}{" "}{data.knowledgeCount || 0}
            {activation.syncedAt ? uiText(" · последняя отправка {p0}", {p0: formatDateTime(activation.syncedAt)}) : ""}
          </p>
        </div>
        <p className="muted">{uiText("Для QR и Meta ручная синхронизация не нужна: опубликованные промпт и база знаний применяются автоматически при подготовке ответов. Green API для этого не требуется.")}</p>
      </div>
      <ModelSettings tenantId={tenantId} runtime={data.runtime || {}} onSaved={load} />
      <section className="panel stack">
        <h3>{uiText("Подключения WhatsApp и готовность ИИ")}</h3>
        {(data.connections || []).map((connection: any) => <div className="card stack" key={connection.id}>
          <b>{connection.type === "whatsapp_qr" ? "WhatsApp · QR" : connection.type === "whatsapp_cloud" ? "WhatsApp · Meta" : "WhatsApp · Green API"} · {connection.name}</b>
          <p>{uiMessage(connection.activation?.prompt?.label)}</p>
          <p className="muted">{uiMessage(connection.activation?.prompt?.reason)}</p>
          {connection.type === "whatsapp_seller" && connection.status === "active" ? <>
            <p className="muted">{uiText("Эта синхронизация относится только к данному подключению Green API.")}</p>
            {syncError ? <InlineFeedback kind="error" className="error">{syncError}</InlineFeedback> : null}
            <div className="actions">
              <button type="button" className="btn secondary" disabled={syncBusy} onClick={() => void sendToWhatsApp()}>
                {syncBusy ? uiText("Отправляем…") : uiText("Синхронизировать Green API")}
              </button>
            </div>
          </> : null}
        </div>)}
        {!data.connections?.length && <p>{uiText("Подключите WhatsApp в кабинете компании любым удобным способом.")}</p>}
      </section>
      <PromptEditor tenantId={tenantId} initial={promptText} activation={promptState} onSaved={load} />
      <KnowledgeEditor tenantId={tenantId} items={data.knowledge || []} activation={knowledgeState} onSaved={load} />
    </div>
  );
}

function PromptEditor({
  tenantId,
  initial,
  activation,
  onSaved,
}: {
  tenantId: string;
  initial: string;
  activation: ActivationPiece;
  onSaved: () => Promise<void>;
}) {
  const uiText = useUiText();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const saved = (await api.adminSaveCompanyAiPrompt(tenantId, { draftPrompt: draft, publish: true })) as {
        activation?: Activation;
      };
      notifySaved(
        saved.activation?.prompt?.live ? uiText("Промт активен в WhatsApp") : uiText("Промт сохранён. В WhatsApp пока не активен"),
      );
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось сохранить промт"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack">
      <div className="integ-status-line">
        <b>{uiText("Промт")}</b>
        <span className={statusBadgeClass(activation.label || "Не задан")}>{uiMessage(activation.label) || uiText("Не задан")}</span>
      </div>
      <p className="muted">
        {uiText("Как бот представляется, как здоровается, что можно обещать и чего нельзя. Юридический тон и стиль — тоже здесь.")}</p>
      <label>
        {uiText("Текст промта")}<textarea
          rows={14}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={uiText("Например: ты менеджер компании… отвечай коротко… цены только из базы знаний…")}
        />
      </label>
      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
          {busy ? uiText("Сохраняем…") : uiText("Сохранить промт")}
        </button>
      </div>
    </div>
  );
}

function KnowledgeEditor({
  tenantId,
  items,
  activation,
  onSaved,
}: {
  tenantId: string;
  items: KnowledgeItem[];
  activation: ActivationPiece;
  onSaved: () => Promise<void>;
}) {
  const uiText = useUiText();
  const [title, setTitle] = useState("");
  const [sourceType, setSourceType] = useState("text");
  const [content, setContent] = useState("");
  const [editingId, setEditingId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function resetForm() {
    setTitle("");
    setContent("");
    setSourceType("text");
    setEditingId("");
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const body = { title, content, sourceType, publish: true };
      const saved = (
        editingId
          ? await api.adminUpdateCompanyKnowledge(tenantId, editingId, body)
          : await api.adminSaveCompanyKnowledge(tenantId, body)
      ) as { activation?: Activation };
      notifySaved(
        saved.activation?.knowledge?.live
          ? uiText("База знаний активна в WhatsApp")
          : uiText("Материал сохранён. В WhatsApp пока не активен"),
      );
      resetForm();
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : uiText("Не удалось сохранить материал"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="integ-status-line">
          <b>{editingId ? uiText("Изменить материал") : uiText("База знаний")}</b>
          <span className={statusBadgeClass(activation.label || "Не задана")}>{uiMessage(activation.label) || uiText("Не задана")}</span>
        </div>
        <p className="muted">
          {uiText("Цены, услуги, FAQ, адреса, условия — то, на что бот должен опираться и не выдумывать.")}</p>
        <label>
          {uiText("Название")}<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={uiText("Прайс, FAQ, филиалы")} />
        </label>
        <label>
          {uiText("Тип")}<select value={sourceType} onChange={(event) => setSourceType(event.target.value)}>
            <option value="text">{uiText("Текст")}</option>
            <option value="faq">FAQ</option>
            <option value="document">{uiText("Документ")}</option>
          </select>
        </label>
        <label>
          {uiText("Содержание")}<textarea
            rows={10}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={uiText("Факты для ответов клиенту")}
          />
        </label>
        {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
        <div className="actions">
          <button type="button" className="btn" disabled={busy || !title.trim()} onClick={() => void save()}>
            {busy ? uiText("Сохраняем…") : editingId ? uiText("Сохранить материал") : uiText("Добавить в базу")}
          </button>
          {editingId ? (
            <button type="button" className="btn secondary" disabled={busy} onClick={resetForm}>
              {uiText("Отмена")}</button>
          ) : null}
        </div>
      </div>
      <div className="panel stack">
        <b>{uiText("Материалы этой компании")}</b>
        {!items.length ? <p className="muted">{uiText("Пока пусто. Добавьте хотя бы цены и список услуг.")}</p> : null}
        {items.map((item) => (
          <div className="row" key={item.id}>
            <div>
              <b>{item.title}</b>
              <div className="muted">{item.sourceType === "faq" ? "FAQ" : item.sourceType === "document" ? uiText("Документ") : uiText("Текст")}</div>
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn secondary"
                onClick={() => {
                  setEditingId(item.id);
                  setTitle(item.title);
                  setSourceType(item.sourceType);
                  setContent(item.content || "");
                }}
              >
                {uiText("Изменить")}</button>
              <button
                type="button"
                className="btn secondary"
                onClick={async () => {
                  if (!window.confirm(uiText("Удалить «{p0}»?", {p0: item.title}))) return;
                  await api.adminDeleteCompanyKnowledge(tenantId, item.id);
                  if (editingId === item.id) resetForm();
                  await onSaved();
                }}
              >
                {uiText("Удалить")}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelSettings({ tenantId, runtime, onSaved }: { tenantId: string; runtime: any; onSaved: () => Promise<void> }) {
  const uiText = useUiText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form className="panel stack" key={`${tenantId}-${runtime.provider}-${runtime.model}-${runtime.enabled}`} onSubmit={async event => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    setBusy(true); setError("");
    try {
      await api.adminUpdateCompanyAi(tenantId, { provider: String(form.get("provider")), model: String(form.get("model")),
        enabled: form.get("enabled") === "on", apiKey: String(form.get("apiKey") || "") });
      const field = element.elements.namedItem("apiKey") as HTMLInputElement | null;
      if (field) field.value = "";
      await api.adminSyncCompanyAiManager(tenantId);
      await onSaved(); notifySaved(uiText("Настройки ИИ сохранены"));
    } catch (error) { setError(error instanceof Error ? error.message : uiText("Ошибка")); }
    finally { setBusy(false); }
  }}>
    <h3>{uiText("Модель ИИ компании")}</h3>
    <p className="muted">{uiText("QR и Meta используют этот ключ модели. Green API продолжает работать через подключённый AI Manager, куда передаются промпт, база знаний и название модели. Ключ модели ИИ отличается от API Token Green API.")}</p>
    <label>{uiText("Провайдер")}<select name="provider" defaultValue={runtime.provider || "openai"}>
      <option value="openai">OpenAI</option><option value="anymodel">AnyModel</option>
      {runtime.provider && !["openai", "anymodel"].includes(runtime.provider) && <option value={runtime.provider}>{runtime.provider}</option>}
    </select></label>
    <label>{uiText("Модель")}<input name="model" defaultValue={runtime.model || ""} required /></label>
    <label>{uiText("Ключ API (не показывается, замена)")}<input type="password" name="apiKey" autoComplete="new-password" /></label>
    <p>{runtime.enabled === false ? uiText("ИИ отключён в настройках компании или сервиса.") : runtime.hasCredential ? uiText("Ключ модели настроен") : uiText("Ключ модели отсутствует или не читается. Укажите действующий ключ.")}</p>
    <label className="check"><input type="checkbox" name="enabled" defaultChecked={runtime.enabled !== false} />{uiText("Разрешить ИИ-ответы компании")}</label>
    {error && <InlineFeedback kind="error" className="error">{error}</InlineFeedback>}
    <button className="btn" disabled={busy}>{busy ? uiText("Сохраняем…") : uiText("Сохранить настройки ИИ")}</button>
    <p className="muted">{uiText("Проверка использует сохранённые настройки и AI-кредиты. Сообщения клиентам не отправляются.")}</p>
    <button type="button" className="btn secondary" disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try {
        const result = await api.adminTestCompanyAiModel(tenantId) as { ok: boolean; message: string };
        if (result.ok) notifySaved(uiMessage(result.message)); else setError(uiMessage(result.message));
      } catch (error) { setError(error instanceof Error ? error.message : uiText("Ошибка")); }
      finally { setBusy(false); }
    }}>{uiText("Проверить модель ИИ")}</button>
  </form>;
}
