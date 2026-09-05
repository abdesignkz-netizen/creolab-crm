import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

export function ControlPage() {
  const [board, setBoard] = useState<any>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busyId, setBusyId] = useState("");

  async function load() {
    try {
      const [control, me] = await Promise.all([api.controlBoard(), api.me()]);
      setBoard({ ...(control as any), me });
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (!board && !error) return <div className="state">Загрузка…</div>;
  if (!board) {
    return (
      <section>
        <p className="error">{error}</p>
        <button className="btn" onClick={load}>Повторить</button>
      </section>
    );
  }

  const myMembership = (board.me as any)?.activeTenant?.membershipId;
  const seller = board.seller;

  async function command(id: string, action: () => Promise<any>) {
    setBusyId(id);
    try {
      const result = await action();
      if (result?.appliedOnSeller === false) {
        setNote(result.sellerError || "На боте не применилось. Режим записан в CRM.");
      } else {
        setNote("");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Команда не выполнена");
    } finally {
      setBusyId("");
    }
  }

  return (
    <section>
      <h2>Управление</h2>
      <p className="muted">
        Команды кабинета и WhatsApp пишут в один режим лида. Открытие карточки не забирает диалог у ИИ.
      </p>
      {error ? <p className="error">{error}</p> : null}
      <div className="card">
        <b>Пульт бота</b>
        <p>{seller.note}</p>
        {seller.leadCountOnBot !== null ? (
          <p className="muted">
            На боте {seller.leadCountOnBot} лидов · в CRM {seller.conversationCount} диалогов
          </p>
        ) : null}
        <div className="actions">
          <Link className="btn secondary" to="/integrations">К интеграциям</Link>
          <button
            className="btn"
            onClick={async () => {
              try {
                const result = (await api.syncWhatsApp()) as any;
                setNote(result.note || `Забрано: новых ${result.imported}, обновлено ${result.updated}.`);
                await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Синхронизация не выполнена");
              }
            }}
          >
            Забрать диалоги
          </button>
        </div>
        {note ? <p>{note}</p> : null}
      </div>

      <h3>Команды по ситуации</h3>
      {board.items.length === 0 ? (
        <p className="empty">Нет диалогов, которые требуют команды. Спокойные чаты ИИ сюда не попадают.</p>
      ) : null}
      {board.items.map((item: any) => {
        const mine = item.ownerMembershipId && item.ownerMembershipId === myMembership;
        const alreadyHuman = item.kind === "conversation_human" && mine;
        return (
          <div className="row" key={item.id}>
            <div>
              <b>{item.title}</b>
              <div className="muted">{item.reason}</div>
              {item.links?.sellerLeadId ? (
                <form
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const formEl = event.currentTarget;
                    const text = String(new FormData(formEl).get("text") || "");
                    await command(item.id, () => api.addInstruction(item.entityId, text));
                    formEl.reset();
                  }}
                >
                  <input name="text" required placeholder="Поручение ИИ, не забирая диалог" />
                  <button className="btn secondary" disabled={busyId === item.id}>Поручить</button>
                </form>
              ) : (
                <p className="muted">Поручение недоступно: сначала синк, чтобы появился sellerLead.</p>
              )}
            </div>
            <div className="actions">
              {alreadyHuman ? (
                <Link className="btn" to={`/conversations/${item.entityId}?focus=reply`}>Ответить</Link>
              ) : item.nextAction === "take_conversation" ? (
                <button className="btn" disabled={busyId === item.id} onClick={() => command(item.id, () => api.takeConversation(item.entityId))}>
                  Забрать себе
                </button>
              ) : null}
              {item.kind === "conversation_paused" ? (
                <button className="btn" disabled={busyId === item.id} onClick={() => command(item.id, () => api.returnToAi(item.entityId))}>
                  Снять паузу
                </button>
              ) : (
                <button className="btn secondary" disabled={busyId === item.id} onClick={() => command(item.id, () => api.pauseConversation(item.entityId))}>
                  Пауза
                </button>
              )}
              {item.kind !== "conversation_paused" && item.nextAction !== "return_to_ai" ? (
                <button className="btn secondary" disabled={busyId === item.id} onClick={() => command(item.id, () => api.returnToAi(item.entityId))}>
                  Вернуть ИИ
                </button>
              ) : null}
              <Link to={`/conversations/${item.entityId}`}>Открыть</Link>
            </div>
          </div>
        );
      })}
    </section>
  );
}
