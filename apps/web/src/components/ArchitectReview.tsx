import { Link } from "react-router-dom";
import type { ArchitectAnswers, ArchitectItem, ArchitectPreview } from "@creolab/contracts";

export function ArchitectReview({ preview, locale, busy, onEdit }: {
  preview: ArchitectPreview; locale: "ru" | "kk"; busy: boolean; onEdit: (field: keyof ArchitectAnswers) => void;
}) {
  const t = (ru: string, kk: string) => locale === "kk" ? kk : ru;
  const status: Record<ArchitectItem["disposition"], string> = { propose: t("Предлагаем", "Ұсынылады"), keep: t("Сохраним как есть", "Сол күйінде сақталады"), review: t("Нужно проверить", "Тексеру керек"), connect: t("Нужно подключить", "Қосу керек"), unavailable: t("Пока недоступно", "Әзірше қолжетімсіз") };
  return <>
    <p className="architect-notice">{t("Это предложения по вашим ответам. Сохраните проект, затем отдельно проверьте и подтвердите точный список изменений. Результат применения показан ниже.", "Бұл — жауаптарыңызға сай ұсыныстар. Жобаны сақтап, нақты өзгерістер тізімін бөлек тексеріп растаңыз. Қолдану нәтижесі төменде көрсетілген.")}</p>
    {preview.questions.length > 0 && <section className="architect-questions"><h3>{t("Нужно уточнить", "Нақтылау керек")} · {preview.questions.length}</h3><ul>{preview.questions.map(q => <li key={q.code}><span>{q.text}</span><button type="button" className="btn secondary" disabled={busy} onClick={() => onEdit(q.field)}>{t("Уточнить", "Нақтылау")}</button></li>)}</ul></section>}
    <div className="architect-cards">{preview.items.map(item => <article key={item.key} className="architect-card"><div className="architect-card-heading"><h3>{item.title}</h3><span className={`architect-badge ${item.disposition}`}>{status[item.disposition]}</span></div><dl><dt>{t("Сейчас", "Қазір")}</dt><dd>{item.current}</dd><dt>{t("В проекте", "Жобада")}</dt><dd>{item.proposed}</dd></dl><p>{item.reason}</p><Link to={item.to}>{t("Открыть настройки", "Баптауларды ашу")} →</Link></article>)}</div>
    {preview.config.ai.successCriteria && <div className="architect-notice"><b>{t("Как проверить результат ИИ", "ЖИ нәтижесін қалай тексеру керек")}</b><p>{preview.config.ai.successCriteria}</p></div>}
    <section><h3>{t("Что важно учесть", "Нені ескеру керек")}</h3><ul className="architect-limits">{preview.limitations.map(v => <li key={v}>{v}</li>)}</ul></section>
  </>;
}
