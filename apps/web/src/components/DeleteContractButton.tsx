import { InlineFeedback } from "./InlineFeedback";
import { uiText, useUiText, localizeUiOptions } from "../lib/uiText";
import { useState } from "react";
import { api } from "../lib/api";
import { notifySaved } from "./SaveNotice";

export function DeleteContractButton({ id, number, disabled, onDeleted }: {
  id: string; number: string; disabled?: boolean; onDeleted: () => void | Promise<void>;
}) {
  const uiText = useUiText();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (busy) return;
    setBusy(true);setError("");
    try {
      await api.request(`/api/v1/contracts/${id}`,{method:"DELETE"});
      notifySaved(uiText("Договор удалён"));
      window.dispatchEvent(new Event("creolab:attention-changed"));
      await onDeleted();
    } catch (err) { setError(err instanceof Error ? err.message : uiText("Не удалось удалить договор")); }
    finally { setBusy(false); }
  }
  return <div className="contract-delete">
    {!confirm ? <button type="button" className="btn secondary" disabled={disabled} onClick={()=>setConfirm(true)}>{uiText("Удалить договор")}</button> : <div role="group" aria-label={uiText("Удаление договора {p0}", {p0: number})}>
      <p>{uiText("Удалить договор")}{" "}{number} {" "}{uiText("и его файлы? Сделка, позиции и реквизиты компании сохранятся. Отменить удаление нельзя.")}</p>
      {error ? <InlineFeedback kind="error" className="error">{error}</InlineFeedback> : null}
      <div className="actions">
        <button type="button" className="btn" disabled={busy || disabled} onClick={()=>void remove()}>{busy ? uiText("Удаляем…") : uiText("Да, удалить")}</button>
        <button type="button" className="btn secondary" disabled={busy} onClick={()=>{setConfirm(false);setError("");}}>{uiText("Отмена")}</button>
      </div>
    </div>}
  </div>;
}
