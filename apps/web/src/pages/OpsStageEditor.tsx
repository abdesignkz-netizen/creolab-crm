import { useEffect, useRef, useState } from "react";

export type EditableStage = {
  id?: string; systemKey: string; name: string; defaultProbability: number | string; slaDays: number | null;
  isArchived: boolean; isBuiltIn: boolean; openDealCount: number;
};
const stagePurpose: Record<string, string> = {
  new: "Здесь появляются новые сделки.",
  in_progress: "Сотрудник начал работу с обращением.",
  need_identified: "Потребность клиента подтверждена.",
  proposal_sent: "Предложение отправлено: отсюда считаем ожидание ответа.",
  negotiation: "Обсуждение условий с клиентом.",
  contract: "Связан с подтверждённым договором.",
  invoiced: "Связан с выставленным счётом.",
};

export default function OpsStageEditor({ stages, onChange, text, business }: {
  stages: EditableStage[]; onChange: (stages: EditableStage[]) => void; text: (value: string) => string; business: boolean;
}) {
  const [focusKey, setFocusKey] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const active = stages.filter(stage => !stage.isArchived), archived = stages.filter(stage => stage.isArchived);
  const baseOrder = Object.keys(stagePurpose);
  const orderNeedsRepair = active[0]?.systemKey !== "new" || active.filter(stage => stage.isBuiltIn).map(stage => stage.systemKey).join() !== baseOrder.join();
  useEffect(() => {
    if (focusKey) root.current?.querySelector<HTMLInputElement>(`[data-stage-name="${focusKey}"]`)?.focus();
  }, [focusKey]);
  function patch(key: string, value: Partial<EditableStage>) { onChange(stages.map(stage => stage.systemKey === key ? { ...stage, ...value } : stage)); }
  function canMove(index: number, delta: number) {
    const next = active[index + delta];
    return Boolean(next && index + delta > 0 && active[index].systemKey !== "new" && !(active[index].isBuiltIn && next.isBuiltIn));
  }
  function move(index: number, delta: number) {
    if (!canMove(index, delta)) return;
    const next = [...active]; [next[index], next[index + delta]] = [next[index + delta], next[index]];
    onChange([...next, ...archived]);
  }
  function add() {
    const systemKey = `custom_${crypto.randomUUID()}`;
    onChange([...active, { systemKey, name: "", defaultProbability: 50, slaDays: null, isArchived: false, isBuiltIn: false, openDealCount: 0 }, ...archived]);
    setFocusKey(systemKey);
  }
  return <section className="ops-block">
    <h3>{text("Этапы сделок")}</h3>
    <p className="muted">{text("Настройте названия и добавьте свои шаги. Порядок основных этапов сохраняет работу ИИ и документов; дополнительные этапы можно перемещать между ними.")}</p>
    {orderNeedsRepair && <div className="ops-note"><p>{text("Основные этапы расположены в нестандартном порядке. Восстановите их порядок перед сохранением; дополнительные этапы окажутся после основных, и их можно будет переместить.")}</p>
      <button className="btn secondary" type="button" onClick={() => onChange([...active.filter(stage => stage.isBuiltIn).sort((a, b) => baseOrder.indexOf(a.systemKey) - baseOrder.indexOf(b.systemKey)), ...active.filter(stage => !stage.isBuiltIn), ...archived])}>{text("Восстановить порядок основных этапов")}</button>
    </div>}
    <p className="ops-note">{text("Вероятность применяется к новым сделкам и следующим переходам. Суммы, история и вероятности существующих сделок не меняются.")}</p>
    <p className="muted">{business ? text("Срок этапа — в рабочих днях. Пустое поле отключает контроль.") : text("Срок этапа — в календарных днях. Пустое поле отключает контроль.")}</p>
    <div className="ops-stages" ref={root}>
      {active.map((stage, index) => <div className="ops-stage" key={stage.systemKey}>
        <div className="ops-stage-heading"><span className="ops-stage-number">{index + 1}</span><span>{text(stage.isBuiltIn ? "Основной этап" : "Дополнительный этап")}</span>
          <span className="muted">{text("Открытых сделок")}: {stage.openDealCount}</span></div>
        <div className="ops-stage-fields">
          <label>{text("Название этапа")}<input data-stage-name={stage.systemKey} maxLength={80} required value={stage.name} onChange={event => patch(stage.systemKey, { name: event.target.value })} /></label>
          <label>{text("Вероятность, %")}<input type="number" min={0} max={100} step={1} required value={stage.defaultProbability} onChange={event => patch(stage.systemKey, { defaultProbability: event.target.value })} /></label>
          <label>{text("Срок, дней")}<input type="number" min={1} max={90} step="any" placeholder="—" value={stage.slaDays ?? ""} onChange={event => patch(stage.systemKey, { slaDays: event.target.value === "" ? null : Number(event.target.value) })} /></label>
        </div>
        <div className="ops-stage-footer"><small className="muted">{text(stagePurpose[stage.systemKey] || "Переход на этот этап выполняет сотрудник.")}</small>
          <div className="ops-stage-actions">
            {(!stage.isBuiltIn || canMove(index, -1) || canMove(index, 1)) && <>
              <button className="btn secondary" type="button" disabled={!canMove(index, -1)} aria-label={`${text("Переместить выше")}: ${stage.name || index + 1}`} onClick={() => move(index, -1)}>↑</button>
              <button className="btn secondary" type="button" disabled={!canMove(index, 1)} aria-label={`${text("Переместить ниже")}: ${stage.name || index + 1}`} onClick={() => move(index, 1)}>↓</button>
            </>}
            {!stage.isBuiltIn && <button className="btn secondary" type="button" disabled={stage.openDealCount > 0} onClick={() => stage.id ? patch(stage.systemKey, { isArchived: true }) : onChange(stages.filter(item => item.systemKey !== stage.systemKey))}>{text(stage.id ? "В архив" : "Убрать")}</button>}
          </div></div>
        {!stage.isBuiltIn && stage.openDealCount > 0 ? <small className="muted">{text("Для архива сначала переведите открытые и отложенные сделки на другой этап.")}</small> : null}
      </div>)}
    </div>
    <button className="btn secondary ops-add-stage" type="button" disabled={active.length >= 30 || stages.length >= 100} onClick={add}>{text("Добавить этап")}</button>
    {archived.length > 0 && <details className="ops-stage-archive"><summary>{text("Архив этапов")} · {archived.length}</summary>
      <p className="muted">{text("История и закрытые сделки сохранены. Архивные этапы не предлагаются для новых переходов.")}</p>
      {archived.map(stage => <div className="ops-stage-archived" key={stage.systemKey}><span>{stage.name}</span><button className="btn secondary" type="button" disabled={active.length >= 30} onClick={() => onChange([...active, { ...stage, isArchived: false }, ...archived.filter(item => item.systemKey !== stage.systemKey)])}>{text("Восстановить")}</button></div>)}
    </details>}
  </section>;
}
