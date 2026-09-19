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
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncError, setSyncError] = useState("");

  async function load() {
    setData(await api.adminCompanyAiManager(tenantId));
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
  }, [tenantId]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <div className="state">Загрузка…</div>;

  const promptText = String(data.prompt?.published || data.prompt?.draft || "");
  const activation = (data.activation || {}) as Activation;
  const promptState = activation.prompt || {};
  const knowledgeState = activation.knowledge || {};
  const whatsappLabel = data.integration ? "Подключён" : "Не подключён";

  async function sendToWhatsApp() {
    setSyncBusy(true);
    setSyncError("");
    try {
      const result = (await api.adminSyncCompanyAiManager(tenantId)) as { activation?: Activation };
      const next = result.activation || {};
      const live = Boolean(next.prompt?.live && next.knowledge?.live);
      notifySaved(live ? "Промт и база активны в WhatsApp" : "Отправлено, но в WhatsApp пока не активно");
      await load();
    } catch (err) {
      setSyncError(err instanceof Error ? err.message : "Не удалось отправить в WhatsApp");
    } finally {
      setSyncBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="panel stack">
        <p>
          Промт и база знаний WhatsApp AI этой компании хранятся здесь. Клиенты CRM их не редактируют. Зелёный статус
          значит, что бот уже отвечает по этим текстам. Если статус жёлтый — в админке сохранено, в WhatsApp ещё нет.
        </p>
        <div className="ai-activation">
          <p className="integ-status-line">
            Промт
            <span className={statusBadgeClass(promptState.label || "Не задан")}>{promptState.label || "Не задан"}</span>
          </p>
          {promptState.reason ? <p className="muted">{promptState.reason}</p> : null}
          <p className="integ-status-line">
            База знаний
            <span className={statusBadgeClass(knowledgeState.label || "Не задана")}>
              {knowledgeState.label || "Не задана"}
            </span>
          </p>
          {knowledgeState.reason ? <p className="muted">{knowledgeState.reason}</p> : null}
          <p className="integ-status-line">
            WhatsApp
            <span className={statusBadgeClass(whatsappLabel)}>{whatsappLabel}</span>
          </p>
          <p className="muted">
            Материалов в базе: {data.knowledgeCount || 0}
            {activation.syncedAt ? ` · последняя отправка ${formatDateTime(activation.syncedAt)}` : ""}
          </p>
        </div>
        {syncError ? <p className="error">{syncError}</p> : null}
        {data.integration ? (
          <div className="actions">
            <button type="button" className="btn secondary" disabled={syncBusy} onClick={() => void sendToWhatsApp()}>
              {syncBusy ? "Отправляем…" : "Отправить в WhatsApp"}
            </button>
          </div>
        ) : null}
      </div>
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
        saved.activation?.prompt?.live ? "Промт активен в WhatsApp" : "Промт сохранён. В WhatsApp пока не активен",
      );
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить промт");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack">
      <div className="integ-status-line">
        <b>Промт</b>
        <span className={statusBadgeClass(activation.label || "Не задан")}>{activation.label || "Не задан"}</span>
      </div>
      <p className="muted">
        Как бот представляется, как здоровается, что можно обещать и чего нельзя. Юридический тон и стиль — тоже здесь.
      </p>
      <label>
        Текст промта
        <textarea
          rows={14}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Например: ты менеджер компании… отвечай коротко… цены только из базы знаний…"
        />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <div className="actions">
        <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
          {busy ? "Сохраняем…" : "Сохранить промт"}
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
          ? "База знаний активна в WhatsApp"
          : "Материал сохранён. В WhatsApp пока не активен",
      );
      resetForm();
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить материал");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="panel stack">
        <div className="integ-status-line">
          <b>{editingId ? "Изменить материал" : "База знаний"}</b>
          <span className={statusBadgeClass(activation.label || "Не задана")}>{activation.label || "Не задана"}</span>
        </div>
        <p className="muted">
          Цены, услуги, FAQ, адреса, условия — то, на что бот должен опираться и не выдумывать.
        </p>
        <label>
          Название
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Прайс, FAQ, филиалы" />
        </label>
        <label>
          Тип
          <select value={sourceType} onChange={(event) => setSourceType(event.target.value)}>
            <option value="text">Текст</option>
            <option value="faq">FAQ</option>
            <option value="document">Документ</option>
          </select>
        </label>
        <label>
          Содержание
          <textarea
            rows={10}
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Факты для ответов клиенту"
          />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <div className="actions">
          <button type="button" className="btn" disabled={busy || !title.trim()} onClick={() => void save()}>
            {busy ? "Сохраняем…" : editingId ? "Сохранить материал" : "Добавить в базу"}
          </button>
          {editingId ? (
            <button type="button" className="btn secondary" disabled={busy} onClick={resetForm}>
              Отмена
            </button>
          ) : null}
        </div>
      </div>
      <div className="panel stack">
        <b>Материалы этой компании</b>
        {!items.length ? <p className="muted">Пока пусто. Добавьте хотя бы цены и список услуг.</p> : null}
        {items.map((item) => (
          <div className="row" key={item.id}>
            <div>
              <b>{item.title}</b>
              <div className="muted">{item.sourceType === "faq" ? "FAQ" : item.sourceType === "document" ? "Документ" : "Текст"}</div>
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
                Изменить
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={async () => {
                  if (!window.confirm(`Удалить «${item.title}»?`)) return;
                  await api.adminDeleteCompanyKnowledge(tenantId, item.id);
                  if (editingId === item.id) resetForm();
                  await onSaved();
                }}
              >
                Удалить
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
