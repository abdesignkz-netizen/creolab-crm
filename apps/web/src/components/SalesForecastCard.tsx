import { useId } from "react";
import { Link } from "react-router-dom";
import type { SalesForecast } from "@creolab/contracts";
import { useLocale } from "../lib/session";
import { forecastDate, forecastIssues, forecastMethodLines, forecastMonthLabel, forecastPaceText, forecastTargetText, forecastText } from "../lib/salesForecastPresentation";
import "./SalesForecastCard.css";

export function SalesForecastCard({ forecast: f, canSetPlan, onCurrentMonth, onRefresh }: {
  forecast?: SalesForecast;
  canSetPlan: boolean;
  onCurrentMonth: () => void;
  onRefresh: () => void;
}) {
  const locale = useLocale();
  const titleId = useId();
  const t: typeof forecastText = (s, p = {}) => forecastText(s, p, locale);
  if (!f) return null;
  const ready = f.status === "ready";
  const risk = ["below_range", "at_risk"].includes(f.target.status);
  const actionable = ready && (risk || f.deviation.status === "below");
  return <section className="stats-forecast" aria-labelledby={titleId}>
    <header className="stats-forecast-head">
      <div><h3 id={titleId}>{t("Прогноз продаж на месяц")}</h3><p>{forecastMonthLabel(f.month, locale)} · {f.currency}</p></div>
      <span>{t("Расчёт на {date} · {zone}", { date: forecastDate(f, locale), zone: f.timeZone })}</span>
    </header>
    {f.status === "unsupported_period" ? <div className="stats-forecast-state">
      <p>{t("Для прогноза выберите текущий месяц. Исторические отчёты остаются отчётами о факте.")}</p>
      <button type="button" className="btn secondary" onClick={onCurrentMonth}>{t("Показать текущий месяц")}</button>
    </div> : f.status === "unavailable" ? <div className="stats-forecast-state" role="status">
      <h4>{t("Не удалось рассчитать прогноз")}</h4><p>{t("Основной отчёт доступен. Повторите расчёт позже.")}</p>
      <button type="button" className="btn secondary" onClick={onRefresh}>{t("Обновить расчёт")}</button>
    </div> : <>
      {ready ? <>
        <dl className="stats-forecast-numbers">
          <div className="stats-forecast-estimate"><dt>{t("Оценка на конец месяца")}</dt><dd>{f.estimate.label}<p>{t("Оценка, а не обещание поступления денег.")}</p></dd></div>
          <div><dt>{t("Продажи на сегодня")}</dt><dd>{f.actual.label}</dd></div>
          <div><dt>{t("Сценарии по прошлым месяцам")}</dt><dd className="stats-forecast-range">{f.range.low.label} — {f.range.high.label}<p>{t("Диапазон показывает разброс прошлых темпов продаж, а не вероятность результата.")}</p></dd></div>
        </dl>
        <div className="stats-forecast-signals">
          <div className={risk ? "stats-forecast-signal is-attention" : "stats-forecast-signal"}>
            <h4>{t("Сравнение с планом")}</h4><p>{forecastTargetText(f, t)}</p>
            {f.target.estimatedPercent != null ? <p>{t("План на полный месяц: {amount}. Оценка выполнения: {percent}%.", { amount: f.target.amount.label!, percent: f.target.estimatedPercent })}</p> : null}
            {f.target.estimatedGap.exact && f.target.estimatedGap.exact !== "0" ? <p>{t("Недостаток до плана по базовой оценке: {amount}.", { amount: f.target.estimatedGap.label! })}</p> : null}
            {canSetPlan && f.target.status === "not_set" ? <Link to="/settings?section=ops#sales-plan">{t("Настроить план")}</Link> : null}
          </div>
          <div className={f.deviation.status === "below" ? "stats-forecast-signal is-attention" : "stats-forecast-signal"}>
            <h4>{t("Темп продаж")}</h4><p>{forecastPaceText(f, t)}</p>
            {f.deviation.expected.label ? <p className="stats-forecast-note">{t("Ориентир на эту часть месяца: {amount}. Сигнал отклонения — от {percent}% после {days} дней; это повод проверить данные и процесс, а не доказательство проблемы.", { amount: f.deviation.expected.label, percent: f.deviation.thresholdPercent, days: f.deviation.minimumDays })}</p> : null}
          </div>
        </div>
      </> : f.status === "incomplete_data" ? <div className="stats-forecast-state is-attention" role="status">
        <h4>{t("Сначала проверьте данные сделок")}</h4>
        <p>{t("Прогноз скрыт: пропуски и некорректные данные могут исказить сумму. После исправления обновите отчёт.")}</p>
        <ul>{forecastIssues(f, t).map(line => <li key={line}>{line}</li>)}</ul>
        <Link to="/deals">{t("Открыть сделки")}</Link>
        <button type="button" className="btn secondary" onClick={onRefresh}>{t("Обновить расчёт")}</button>
      </div> : <div className="stats-forecast-state">
        <h4>{t("Нужно накопить историю продаж")}</h4>
        <p>{t("Для расчёта нужны минимум {months} полных месяца и {sales} успешных сделок за эти месяцы.", { months: f.evidence.requiredMonths, sales: f.evidence.requiredSales })}</p>
        <div className="stats-forecast-progress"><span>{t("Полных месяцев: {count} (минимум {required})", { count: f.evidence.months, required: f.evidence.requiredMonths })}</span><span>{t("Продаж в истории: {count} (минимум {required})", { count: f.evidence.sales, required: f.evidence.requiredSales })}</span></div>
      </div>}
      {actionable ? <div className="stats-forecast-actions"><Link className="btn secondary" to="/deals">{t("Открыть сделки")}</Link><Link className="btn secondary" to="/tasks">{t("Открыть задачи")}</Link></div> : null}
      {f.filtered ? <p className="stats-forecast-note">{t("Расчёт использует те же фильтры, что и отчёт.")}</p> : null}
      {f.evidence.otherCurrencySales ? <p className="stats-forecast-note">{t("Продажи в других валютах исключены: {count}. Конвертации валют нет.", { count: f.evidence.otherCurrencySales })}</p> : null}
      <details className="stats-forecast-details"><summary>{t("Как посчитано")}</summary>
        <div className="stats-forecast-method">{forecastMethodLines(f, t).map(line => <p key={line}>{line}</p>)}
          {f.evidence.firstRecordAt ? <p>{t("Первая запись сделки: {date}.", { date: forecastDate(f, locale, f.evidence.firstRecordAt) })}</p> : null}
        </div>
        {f.history.length ? <div className="stats-table-wrap" tabIndex={0}><table className="stats-table"><caption>{t("История расчёта")}</caption>
          <thead><tr><th scope="col">{t("Месяц")}</th><th scope="col">{t("Успешные сделки")}</th><th scope="col">{t("Сумма продаж")}</th></tr></thead>
          <tbody>{f.history.map(row => <tr key={row.month}><th scope="row">{forecastMonthLabel(row.month, locale)}</th><td>{row.sales}</td><td>{row.missingAmounts ? "—" : row.total.label}</td></tr>)}</tbody>
        </table></div> : null}
        {ready ? <div className="stats-forecast-validation">
          <h4>{t("Проверка на прошлых месяцах")}</h4>
          <p>{t("Каждый прошлый месяц оценён на его начало только по более ранним месяцам. Это проверка метода на более длинном горизонте, а не точность сегодняшнего прогноза.")}</p>
          {!f.validation.periods.length ? <p>{t("Пока нет месяцев для независимой проверки: нужны минимум четыре полных месяца и десять продаж в предыдущих месяцах.")}</p> : <>
            <p>{t("Проверено месяцев: {count}. Среднее абсолютное отклонение: {amount}.", { count: f.validation.periods.length, amount: f.validation.meanAbsoluteError.label! })}</p>
            <p>{f.validation.weightedAbsoluteErrorPercent == null ? t("При нулевой сумме факта относительная ошибка не рассчитывается.") : t("Сумма абсолютных отклонений / сумма фактических продаж: {percent}%.", { percent: f.validation.weightedAbsoluteErrorPercent })}</p>
            <div className="stats-table-wrap" tabIndex={0}><table className="stats-table"><thead><tr><th scope="col">{t("Месяц")}</th><th scope="col">{t("Оценка")}</th><th scope="col">{t("Факт")}</th><th scope="col">{t("Абсолютное отклонение")}</th></tr></thead>
              <tbody>{f.validation.periods.map(row => <tr key={row.month}><th scope="row">{forecastMonthLabel(row.month, locale)}</th><td>{row.estimate.label}</td><td>{row.actual.label}</td><td>{row.absoluteError.label}</td></tr>)}</tbody>
            </table></div>
          </>}
        </div> : null}
      </details>
    </>}
  </section>;
}
