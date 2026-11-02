import { Link } from "react-router-dom";
import type { ArchitectApplyReview } from "@creolab/contracts";

export function ArchitectApplicationReview({ review, locale, busy, confirmed, onConfirm, onApply, onCancel, onRefresh }: {
  review: ArchitectApplyReview; locale: "ru" | "kk"; busy: boolean; confirmed: boolean;
  onConfirm: (value: boolean) => void; onApply: () => void; onCancel: () => void; onRefresh: () => void;
}) {
  const t = (ru: string, kk: string) => locale === "kk" ? kk : ru, run = review.run;
  const pending = Boolean(run && ["queued", "running"].includes(run.status)), succeeded = run?.status === "succeeded";
  const statuses = { draft: t("Подготовлено", "Дайындалды"), queued: t("Ожидает выполнения", "Орындалуын күтуде"), running: t("Применяем настройки", "Баптаулар қолданылуда"), succeeded: t("Настройки сохранены", "Баптаулар сақталды"), failed: t("Изменения не применены", "Өзгерістер қолданылған жоқ"), cancelled: t("Применение отменено", "Қолдану тоқтатылды"), expired: t("Срок подтверждения истёк", "Растау мерзімі аяқталды") };
  return <div className="architect-application-review">
    <h3>{succeeded ? t("Результат применения", "Қолдану нәтижесі") : t("Проверьте изменения перед применением", "Қолданар алдында өзгерістерді тексеріңіз")}</h3>
    {run && <div className="architect-notice" role="status"><b>{statuses[run.status]}</b>{run.error && <p>{run.error}</p>}{pending && <p>{t("Изменения сохраняются вместе. Можно отменить ожидание до начала сохранения.", "Өзгерістер бірге сақталады. Сақтау басталғанға дейін күтуді тоқтатуға болады.")}</p>}</div>}
    {review.blockers.length > 0 && <div className="architect-notice" role="alert"><b>{t("Сначала уточните проект", "Алдымен жобаны нақтылаңыз")}</b><ul>{review.blockers.map((text, i) => <li key={i}>{text}</li>)}</ul></div>}
    <div className="architect-cards">{review.changes.map(change => {
      const done = run?.steps.find(step => step.key === change.key)?.status === "succeeded";
      return <article className="architect-card" key={change.key}><h4>{change.title}</h4>{done && <span className="architect-badge keep">{t("Выполнено", "Орындалды")}</span>}
        <dl><dt>{t("До применения", "Қолдануға дейін")}</dt><dd>{change.before}</dd><dt>{succeeded ? t("Сохранено", "Сақталды") : t("После применения", "Қолданудан кейін")}</dt><dd className="architect-change-text">{change.after}</dd></dl>
        <Link to={change.to}>{t("Открыть раздел", "Бөлімді ашу")} →</Link></article>;
    })}</div>
    {!review.changes.length && !review.blockers.length && <p>{t("Нет изменений для этого шага. Проверьте настройки и подключения ниже.", "Бұл қадамда қолданатын өзгерістер жоқ. Төмендегі баптаулар мен қосылымдарды тексеріңіз.")}</p>}
    <section className="architect-pending"><h4>{t("Осталось сделать отдельно", "Бөлек орындау керек")}</h4><ul>{review.pending.map((item, i) => <li key={i}><span>{item.text}</span> <Link to={item.to}>{t("Перейти", "Өту")} →</Link></li>)}</ul></section>
    {review.canApply && !pending && !succeeded && <>
      <label className="architect-confirm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e => onConfirm(e.target.checked)} /><span>{t("Я проверил список и подтверждаю применение только перечисленных изменений.", "Тізімді тексердім және тек аталған өзгерістерді қолдануды растаймын.")}</span></label>
      <button className="btn" type="button" disabled={busy || !confirmed} onClick={onApply}>{busy ? t("Проверяем…", "Тексерілуде…") : t("Применить перечисленные изменения", "Аталған өзгерістерді қолдану")}</button>
    </>}
    <div className="architect-actions">{run?.canCancel && <button className="btn secondary" type="button" disabled={busy} onClick={onCancel}>{t("Отменить применение", "Қолдануды тоқтату")}</button>}<button className="btn secondary" type="button" disabled={busy} onClick={onRefresh}>{t("Обновить проверку", "Тексеруді жаңарту")}</button></div>
  </div>;
}
