import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";

const ACTION_LABEL: Record<string, string> = {
  complete_phone: "Дописать телефон",
  accept_inquiry: "Принять заявку",
  open_inquiry: "Открыть заявку",
  take_conversation: "Забрать себе",
  reply_human: "Ответить",
  return_to_ai: "Вернуть ИИ",
  resume_paused: "Снять паузу",
  complete_task: "Закрыть задачу",
  assign_owner: "Назначить себе",
  instruct_ai: "Поручить ИИ",
  open_contact: "Открыть клиента",
  create_next_action: "Задать следующий шаг",
};

function sourceHref(item: any) {
  if (item.kind === "needs_phone") return "/inquiries";
  if (item.kind.startsWith("inquiry_") || item.kind === "missing_next_action") {
    return item.links?.contactId ? `/contacts/${item.links.contactId}` : "/inquiries";
  }
  if (item.kind === "contact_needs_reply") return `/contacts/${item.entityId}`;
  if (item.kind.startsWith("conversation_")) {
    const focus = item.nextAction === "reply_human" ? "?focus=reply" : "";
    return `/conversations/${item.entityId}${focus}`;
  }
  return "/tasks";
}

function syncLabel(lastSyncAt: string | null) {
  if (!lastSyncAt) return "не было";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(lastSyncAt).getTime()) / 60000));
  if (minutes < 2) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  return `${Math.round(minutes / 60)} ч назад`;
}

function botLabel(seller: { configured: boolean; reachable: boolean }) {
  if (!seller.configured) return "не подключён";
  return seller.reachable ? "отвечает" : "нет";
}

function emptyCopy(data: any) {
  const seller = data.freshness.seller;
  const warning = data.freshness.warning;
  if (warning && data.items.length === 0 && seller.configured && !seller.reachable) {
    return "Заявки и задачи пусты, WhatsApp не подтянуть";
  }
  if (data.items.length === 0 && !seller.configured) {
    return "Пока нет работы. Форма и задачи работают без WhatsApp";
  }
  if (data.items.length === 0 && seller.reachable && !seller.lastSyncAt) {
    return "В CRM пусто. Синк идёт автоматически каждую минуту — или ждите заявку с сайта";
  }
  if (data.items.length === 0 && seller.reachable && seller.lastSyncAt && seller.leadCountOnBot === 0) {
    return "На боте нет сохранённых лидов (часто после рестарта Render без диска). WhatsApp у клиентов при этом может быть жив";
  }
  if (data.items.length === 0 && seller.leadCountOnBot > 0 && seller.conversationCount === 0) {
    return "На боте есть лиды, в CRM нет диалогов — это ошибка синка, не «всё спокойно»";
  }
  return "Сейчас делать нечего";
}

export function SituationPage() {
  const navigate = useNavigate();
  const [scope, setScope] = useState<"all" | "mine" | "unassigned">("all");
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [meMissing, setMeMissing] = useState(false);

  async function load(nextScope = scope) {
    try {
      const me = (await api.me()) as any;
      if (!me.activeTenant) {
        setMeMissing(true);
        setData(null);
        return;
      }
      setMeMissing(false);
      setData(await api.situation({ scope: nextScope }));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  useEffect(() => {
    load();
    const timer = window.setInterval(() => {
      void load();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [scope]);

  async function run(item: any, action: () => Promise<unknown>) {
    setBusyId(item.id);
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не выполнено");
    } finally {
      setBusyId("");
    }
  }

  if (meMissing) {
    return (
      <section>
        <h2>Ситуация</h2>
        <p className="empty">Нет компании — войдите заново.</p>
        <Link className="btn" to="/login">Войти</Link>
      </section>
    );
  }
  if (!data && !error) return <div className="state">Загрузка…</div>;
  if (!data) {
    return (
      <section>
        <p className="error">{error}</p>
        <button className="btn" onClick={() => load()}>Повторить</button>
      </section>
    );
  }

  const seller = data.freshness.seller;

  return (
    <section>
      <h2>Ситуация</h2>
      <div className="freshness">
        <span>Бот: {botLabel(seller)}</span>
        <span>Синк: {syncLabel(seller.lastSyncAt)}</span>
        {seller.leadCountOnBot !== null ? (
          <span>
            На боте {seller.leadCountOnBot} · в CRM {seller.conversationCount}
          </span>
        ) : null}
      </div>
      {data.freshness.warning ? (
        <div className="banner warn">
          <span>{data.freshness.warning}</span>
          {!seller.configured || !seller.reachable ? (
            <Link className="btn secondary" to="/integrations">К интеграциям</Link>
          ) : (
            <span className="muted">Синк автоматический · каждую минуту</span>
          )}
        </div>
      ) : null}
      {error ? <p className="error">{error}</p> : null}

      <div className="cards">
        <div className="card"><span className="muted">Сейчас</span><strong>{data.metrics.now}</strong></div>
        <div className="card"><span className="muted">Без телефона</span><strong>{data.metrics.blocked}</strong></div>
        <div className="card"><span className="muted">Нужен человек</span><strong>{data.metrics.needsHuman}</strong></div>
        <div className="card"><span className="muted">Просрочено</span><strong>{data.metrics.overdue}</strong></div>
      </div>

      <div className="actions" style={{ marginTop: 16 }}>
        {(["all", "mine", "unassigned"] as const).map((value) => (
          <button
            key={value}
            className={scope === value ? "btn" : "btn secondary"}
            onClick={() => setScope(value)}
          >
            {value === "all" ? "Все" : value === "mine" ? "Мои" : "Без ответственного"}
          </button>
        ))}
      </div>

      {data.items.length === 0 ? <p className="empty">{emptyCopy(data)}</p> : null}
      {data.items.map((item: any) => (
        <div className={`row severity-${item.severity}`} key={item.id}>
          <div>
            <b>{item.title}</b>
            <div className="muted">{item.reason}</div>
            <div className="muted">
              {ACTION_LABEL[item.nextAction]}
              {" · "}
              {item.ownerMembershipId ? "есть ответственный" : "без ответственного"}
              {item.dueAt ? ` · до ${new Date(item.dueAt).toLocaleString("ru-RU")}` : ` · ${item.ageMinutes} мин`}
              {item.freshness !== "unknown" ? ` · ${item.freshness}` : ""}
            </div>
            {item.nextAction === "complete_phone" ? (
              <form
                className="inline-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = new FormData(event.currentTarget);
                  run(item, () =>
                    api.completeIntake(item.entityId, { phone: form.get("phone"), name: form.get("name") }),
                  );
                }}
              >
                <input name="name" placeholder="Имя" />
                <input name="phone" required placeholder="+7..." />
                <button className="btn" disabled={busyId === item.id}>
                  {ACTION_LABEL.complete_phone}
                </button>
              </form>
            ) : null}
          </div>
          <div className="actions">
            {item.nextAction !== "complete_phone" ? (
              <button
                className="btn"
                disabled={busyId === item.id}
                onClick={() => {
                  if (item.nextAction === "accept_inquiry") return run(item, () => api.acceptInquiry(item.entityId));
                  if (item.nextAction === "open_inquiry") return navigate("/inquiries");
                  if (item.nextAction === "take_conversation") return run(item, () => api.takeConversation(item.entityId));
                  if (item.nextAction === "reply_human") return navigate(`/conversations/${item.entityId}?focus=reply`);
                  if (item.nextAction === "return_to_ai" || item.nextAction === "resume_paused") {
                    return run(item, () => api.returnToAi(item.entityId));
                  }
                  if (item.nextAction === "complete_task") return run(item, () => api.completeTask(item.entityId));
                  if (item.nextAction === "assign_owner") return run(item, () => api.assignTask(item.entityId));
                  if (item.nextAction === "instruct_ai") return navigate("/control");
                  if (item.nextAction === "open_contact") return navigate(`/contacts/${item.entityId}`);
                  if (item.nextAction === "create_next_action") {
                    return navigate(item.links?.contactId ? `/contacts/${item.links.contactId}` : "/tasks");
                  }
                }}
              >
                {ACTION_LABEL[item.nextAction]}
              </button>
            ) : null}
            <Link className="btn secondary" to={sourceHref(item)}>Карточка</Link>
          </div>
        </div>
      ))}
    </section>
  );
}
