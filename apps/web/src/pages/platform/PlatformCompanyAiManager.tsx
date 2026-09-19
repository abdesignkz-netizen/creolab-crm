import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { notifySaved } from "../../components/SaveNotice";
import { PlatformAiUsagePage } from "./PlatformAiUsagePage";

const INNER = [
  ["prompt", "Основной промт"],
  ["knowledge", "База знаний"],
  ["settings", "Настройки модели"],
  ["integrations", "Интеграции"],
  ["usage", "AI Usage"],
  ["preview", "Протестировать AI"],
] as const;

export function PlatformCompanyAiManager({ tenantId }: { tenantId: string }) {
  const [tab, setTab] = useState<(typeof INNER)[number][0]>("prompt");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");

  async function load() {
    setData(await api.adminCompanyAiManager(tenantId));
  }

  useEffect(() => {
    void load().catch((err) => setError(err instanceof Error ? err.message : "Ошибка"));
  }, [tenantId]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <div className="state">Загрузка…</div>;

  return (
    <div className="stack">
      <div className="panel">
        <p>Статус · {data.status === "active" ? "Активен" : data.status}</p>
        <p>Модель · {data.model || "инфраструктура сервиса"}</p>
        <p>Knowledge Base · {data.knowledgeCount} материала</p>
        <p>WhatsApp · {data.integration ? "Connected" : "не подключён"}</p>
        <p className="muted">
          Последнее изменение · {data.prompt?.updatedAt ? new Date(data.prompt.updatedAt).toLocaleString("ru-RU") : "нет"}
        </p>
      </div>
      <nav className="settings-nav horizontal">
        {INNER.map(([key, label]) => (
          <button key={key} type="button" className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </nav>
      {tab === "prompt" ? <PromptEditor tenantId={tenantId} data={data} onSaved={load} /> : null}
      {tab === "knowledge" ? <KnowledgeEditor tenantId={tenantId} data={data} onSaved={load} /> : null}
      {tab === "settings" ? <ModelSettings tenantId={tenantId} data={data} onSaved={load} /> : null}
      {tab === "integrations" ? (
        <div className="panel">
          {data.integration ? (
            <>
              <p>Integration ID · {data.integration.id}</p>
              <p>Instance ID · {data.integration.instanceId || "не задан"}</p>
              <p>Секрет · {data.integration.secretSet ? "задан" : "нет"}</p>
            </>
          ) : (
            <p className="muted">WhatsApp ещё не подключён. Подключение — во вкладке «Интеграции» карточки компании.</p>
          )}
        </div>
      ) : null}
      {tab === "usage" ? <PlatformAiUsagePage lockedTenantId={tenantId} /> : null}
      {tab === "preview" ? <PreviewChat tenantId={tenantId} /> : null}
    </div>
  );
}

function PromptEditor({ tenantId, data, onSaved }: { tenantId: string; data: any; onSaved: () => Promise<void> }) {
  const [draft, setDraft] = useState(String(data.prompt?.draft || data.prompt?.published || ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(String(data.prompt?.draft || data.prompt?.published || ""));
  }, [data.prompt?.draft, data.prompt?.published]);

  async function save(publish: boolean) {
    setBusy(true);
    setError("");
    try {
      await api.adminSaveCompanyAiPrompt(tenantId, { draftPrompt: draft, publish });
      notifySaved(publish ? "Промт опубликован" : "Черновик сохранён");
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack">
      <p className="muted">Статус: {data.prompt?.status === "published" ? "опубликован" : "черновик"}. AI использует только опубликованную версию.</p>
      <label>
        System Prompt
        <textarea rows={16} value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
      {error ? <p className="error">{error}</p> : null}
      <div className="actions">
        <button type="button" className="btn secondary" disabled={busy} onClick={() => void save(false)}>
          Сохранить черновик
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void save(true)}>
          Опубликовать
        </button>
        <button type="button" className="btn secondary" onClick={() => setDraft(String(data.prompt?.draft || data.prompt?.published || ""))}>
          Отменить изменения
        </button>
      </div>
    </div>
  );
}

function KnowledgeEditor({ tenantId, data, onSaved }: { tenantId: string; data: any; onSaved: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [sourceType, setSourceType] = useState("text");
  const [content, setContent] = useState("");
  const [editingId, setEditingId] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<any[]>([]);
  const [error, setError] = useState("");

  async function save(publish: boolean) {
    try {
      if (editingId) {
        await api.adminUpdateCompanyKnowledge(tenantId, editingId, { title, content, sourceType, publish });
      } else {
        await api.adminSaveCompanyKnowledge(tenantId, { title, content, sourceType, publish });
      }
      setTitle("");
      setContent("");
      setEditingId("");
      notifySaved(publish ? "Материал опубликован" : "Материал сохранён");
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить");
    }
  }

  return (
    <div className="stack">
      <div className="panel stack">
        <h4>{editingId ? "Изменить материал" : "Добавить материал"}</h4>
        <label>Название<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
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
          <textarea rows={8} value={content} onChange={(event) => setContent(event.target.value)} />
        </label>
        {error ? <p className="error">{error}</p> : null}
        <div className="actions">
          <button type="button" className="btn secondary" onClick={() => void save(false)}>Сохранить</button>
          <button type="button" className="btn" onClick={() => void save(true)}>Опубликовать</button>
        </div>
      </div>
      <div className="panel stack">
        <h4>База знаний</h4>
        {(data.knowledge || []).map((item: any) => (
          <div className="row" key={item.id}>
            <div>
              <b>{item.title}</b>
              <div className="muted">{item.sourceType} · {item.status}</div>
            </div>
            <div className="actions">
              <button type="button" className="btn secondary" onClick={() => {
                setEditingId(item.id);
                setTitle(item.title);
                setSourceType(item.sourceType);
                setContent(item.content || "");
              }}>Изменить</button>
              <button type="button" className="btn secondary" onClick={async () => {
                await api.adminDeleteCompanyKnowledge(tenantId, item.id);
                await onSaved();
              }}>Удалить</button>
            </div>
          </div>
        ))}
      </div>
      <div className="panel stack">
        <h4>Проверить базу знаний</h4>
        <label>
          Запрос
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Какая стоимость массажа?" />
        </label>
        <button
          type="button"
          className="btn secondary"
          onClick={async () => {
            const result = (await api.adminSearchCompanyKnowledge(tenantId, query)) as any;
            setHits(result.items || []);
          }}
        >
          Найти
        </button>
        {hits.map((item) => (
          <p key={item.id}><b>{item.title}</b> · {item.excerpt || item.sourceType}</p>
        ))}
      </div>
    </div>
  );
}

function ModelSettings({ tenantId, data, onSaved }: { tenantId: string; data: any; onSaved: () => Promise<void> }) {
  const [error, setError] = useState("");
  return (
    <form
      className="panel stack"
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        try {
          await api.adminUpdateCompanyAi(tenantId, {
            provider: String(form.get("provider") || ""),
            model: String(form.get("model") || ""),
            temperature: form.get("temperature") ? Number(form.get("temperature")) : null,
            maxOutputTokens: form.get("maxOutputTokens") ? Number(form.get("maxOutputTokens")) : null,
            enabled: true,
          });
          notifySaved("Настройки модели сохранены");
          await onSaved();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Ошибка");
        }
      }}
    >
      <label>Провайдер<input name="provider" defaultValue={data.provider || ""} /></label>
      <label>Модель<input name="model" defaultValue={data.model || ""} /></label>
      <label>Temperature<input name="temperature" type="number" step="0.1" defaultValue="" /></label>
      <label>Max output tokens<input name="maxOutputTokens" type="number" defaultValue="" /></label>
      {error ? <p className="error">{error}</p> : null}
      <button className="btn">Сохранить</button>
    </form>
  );
}

function PreviewChat({ tenantId }: { tenantId: string }) {
  const [message, setMessage] = useState("Здравствуйте, сколько стоит услуга?");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="panel stack">
      <p className="muted">Sandbox: не создаёт заявку, не пишет в WhatsApp и не выполняет CRM-команды.</p>
      <label>
        Сообщение клиента
        <textarea rows={4} value={message} onChange={(event) => setMessage(event.target.value)} />
      </label>
      <button
        type="button"
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const result = (await api.adminPreviewCompanyAi(tenantId, message)) as any;
            setReply(result.reply || "");
          } finally {
            setBusy(false);
          }
        }}
      >
        Протестировать AI
      </button>
      {reply ? <pre className="code">{reply}</pre> : null}
    </div>
  );
}
