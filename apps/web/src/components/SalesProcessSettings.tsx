import { SALES_GOALS, type SalesProcessSettings } from "@creolab/contracts";
import "./sales-process.css";
import { Link } from "react-router-dom";

export function SalesProcessSettingsPanel({ value, onChange, members, ready, enableAnalysis, href }: {
  value: SalesProcessSettings; onChange: (next: SalesProcessSettings) => void; members: Array<{ id: string; name: string }>;
  href: (path: string) => string; ready: boolean; enableAnalysis: () => void;
}) {
  return <div className="panel sales-settings">
    <h3>От обращения до продажи</h3>
    <p className="muted">ИИ выявляет потребность, помогает выбрать предложение и планирует следующий шаг. Вы определяете цель и границы самостоятельной работы.</p>
    <fieldset><legend>1. Когда создавать сделку</legend><div className="sales-modes">
      {([['off', 'Вручную', 'Вы сами решаете, когда создать сделку.'], ['suggest', 'Предлагать', 'ИИ подготовит сделку для вашей проверки.'], ['auto', 'Автоматически', 'При подтверждённом интересе и понятной потребности.']] as const).map(([mode, label, hint]) => <label key={mode} className={value.mode === mode ? 'selected' : ''}>
        <input type="radio" name="salesMode" checked={value.mode === mode} onChange={() => onChange({ ...value, mode })} /><span><b>{label}</b><small>{hint}</small></span>
      </label>)}
    </div></fieldset>
    {value.mode !== 'off' && <>
      {!ready && <div className="warn" role="status"><p>Для обработки переписки нужен включённый анализ CRM. Сейчас предложения и автоматические сделки не создаются.</p><button type="button" className="btn secondary" onClick={enableAnalysis}>Включить анализ и CRM</button><p className="muted">После сохранения ИИ сможет обновлять CRM. Разрешение писать клиентам определяется отдельно настройками канала.</p></div>}
      <label>2. Какой результат нужен<select value={value.goal} onChange={e => onChange({ ...value, goal: e.target.value as SalesProcessSettings['goal'] })}>{Object.entries(SALES_GOALS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <p className="muted">Цель считается достигнутой по данным CRM: квалификация, подтверждённая встреча, отправленное предложение, согласованный заказ или подтверждённая оплата. Закрытие сделки остаётся отдельным действием.</p>
      <label>3. Ответственный, если он ещё не назначен<select value={value.assigneeMembershipId || ''} onChange={e => onChange({ ...value, assigneeMembershipId: e.target.value || null })}><option value="">Сохранить ответственного клиента; иначе оставить без назначения</option>{members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <label>Срок следующего шага, если время не согласовано<input type="number" min={1} max={720} value={value.nextStepHours} onChange={e => onChange({ ...value, nextStepHours: Number(e.target.value) })} /><small>Часов по календарю компании из раздела «Правила сделок». В рабочем режиме считаются только часы внутри смен: 24 часа при 8-часовой смене — 3 рабочих дня. Согласованные даты не переносятся.</small></label>
      <fieldset><legend>4. Что делать автоматически</legend>
        <label className="check-row"><input type="checkbox" checked={value.ensureNextStep} onChange={e => onChange({ ...value, ensureNextStep: e.target.checked })} />Создавать задачу следующего шага, если других открытых задач нет</label>
        <label className="check-row"><input type="checkbox" checked={value.syncDocuments} onChange={e => onChange({ ...value, syncDocuments: e.target.checked })} />Обновлять этап по выставленному счёту и подписанному договору</label>
        <label className="check-row"><input type="checkbox" checked={value.notifyResponsible} onChange={e => onChange({ ...value, notifyResponsible: e.target.checked })} />Сообщать ответственному о предложениях, препятствиях и достигнутой цели</label>
      </fieldset>
      <p className="muted">Продолжение переписки сохраняется в связанной сделке. Если у клиента уже есть другой заказ, ИИ предложит выбрать сделку или подтвердить создание отдельной. Документы и сообщения отправляются по действующим правилам подтверждения.</p>
      <p><Link to={href("/settings/ai-manager")}>Настроить знания и сценарий продажи</Link>{href("/settings") === "/settings" && <> · <Link to="/control?view=sales">Продажи под контролем</Link></>}</p>
      <p className="muted">Расписание, повторные сообщения и передача сотруднику задаются в соседних разделах настроек. Уведомления в WhatsApp владельца — в настройках BasQar Control.</p>
    </>}
  </div>;
}
