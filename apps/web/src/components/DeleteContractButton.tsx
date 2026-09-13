import { useState } from "react";
import { api } from "../lib/api";
import { notifySaved } from "./SaveNotice";

export function DeleteContractButton({ id, number, disabled, onDeleted }: {
  id: string; number: string; disabled?: boolean; onDeleted: () => void | Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (busy) return;
    setBusy(true);setError("");
    try {
      await api.request(`/api/v1/contracts/${id}`,{method:"DELETE"});
      notifySaved("Договор удалён");
      window.dispatchEvent(new Event("creolab:attention-changed"));
      await onDeleted();
    } catch (err) { setError(err instanceof Error ? err.message : "Не удалось удалить договор"); }
    finally { setBusy(false); }
  }
  return <div className="contract-delete">
    {!confirm ? <button type="button" className="btn secondary" disabled={disabled} onClick={()=>setConfirm(true)}>Удалить договор</button> : <div role="group" aria-label={`Удаление договора ${number}`}>
      <p>Удалить договор {number} и его файлы? Сделка, позиции и реквизиты компании сохранятся. Отменить удаление нельзя.</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="actions">
        <button type="button" className="btn" disabled={busy || disabled} onClick={()=>void remove()}>{busy ? "Удаляем…" : "Да, удалить"}</button>
        <button type="button" className="btn secondary" disabled={busy} onClick={()=>{setConfirm(false);setError("");}}>Отмена</button>
      </div>
    </div>}
  </div>;
}
