import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { InlineFeedback } from "./InlineFeedback";
import { useUiText } from "../lib/uiText";

type Row = { id: string; aiEnabled: boolean; connected: boolean };
export function ChannelAiControl({ id }: { id: string }) {
  const t = useUiText();
  const [row, setRow] = useState<Row | null>(null), [readiness, setReadiness] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [note, setNote] = useState("");
  async function load() { const result = await api.channelAiStatus() as { readiness: string | null; items: Row[] }; setRow(result.items.find(item => item.id === id) || null); setReadiness(result.readiness); }
  useEffect(() => { void load().catch(err => setError(err.message)); }, [id]);
  return <div className="channel-ai-control">
    <div><strong>{t("Кто отвечает клиентам")}</strong><p className="muted">{t("ИИ использует общую базу знаний компании, аудиторию и расписание. Диалоги, уже переданные сотруднику, остаются у сотрудника.")}</p></div>
    <label className="check-row"><input type="checkbox" checked={row?.aiEnabled || false} disabled={!row?.connected || busy} onChange={async event => {
      const enabled = event.target.checked; setBusy(true); setError(""); setNote("");
      try { await api.setChannelAi(id, enabled); await load(); setNote(t(enabled ? "ИИ включён для новых диалогов по общим правилам. Для старого диалога нажмите «Вернуть AI»." : "Автоматические ответы в этом канале выключены.")); }
      catch(err) { setError(err instanceof Error ? err.message : t("Не удалось сохранить")); } finally { setBusy(false); }
    }}/><span>{t(busy ? "Сохраняем…" : "Отвечать с помощью ИИ")}</span></label>
    {row?.aiEnabled && readiness && <p className="warning">{t("ИИ ещё не готов к работе: проверьте публикацию инструкций, модель и включение ИИ в настройках.")}</p>}
    <div className="actions"><Link to="/settings/ai-manager">{t("Знания и цель ИИ")}</Link><Link to="/settings/ai-automation">{t("Кому и когда отвечать")}</Link><Link to="/conversations">{t("Открыть диалоги")}</Link></div>
    {error && <InlineFeedback kind="error">{error}</InlineFeedback>}{note && <InlineFeedback kind="success">{note}</InlineFeedback>}
  </div>;
}
