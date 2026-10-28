import { analyticsText, planExplanation } from "./analyticsCopy";
import { uiText, useUiText, localizeUiOptions } from "./uiText";
import { analyticsCoverageLines } from "./analyticsCoverage";
type ReportSections = {
  overview: boolean;
  funnel: boolean;
  sources: boolean;
  services: boolean;
  sales: boolean;
  losses: boolean;
};

function esc(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function financialReportLines(data: any): string[] {
  if (!data.financial) return [];
  const lines = [uiText("Продажи — по дате закрытия сделки. Оплаты — по дате подтверждения платежа. Валюты не суммируются."),
    uiText("Денежные показатели и графики: {currency}.", { currency: data.currency })];
  for (const [name, values] of [[uiText("Сумма продаж"), data.financial.sales?.byCurrency], [uiText("Подтверждённые оплаты"), data.financial.receipts?.byCurrency]] as const) {
    for (const row of values || []) {
      lines.push(`${name}: ${row.label || `— ${row.currency}`}`);
      if (row.missing) lines.push(uiText("Сделок без суммы: {count}", { count: row.missing }) + ` (${row.currency})`);
    }
  }
  lines.push(analyticsText("Успешные / все закрытые сделки за период. Открытые сделки не входят."));
  if (data.funnel) lines.push(analyticsText(data.funnel.mode === "cohort" ? "Обращения выбранного периода и результат на сегодня. Каждое обращение учитывается один раз на этапе; поздние продажи тоже входят." : "События периода: каждый этап считается отдельно. Повторный вход одной сделки в этап не увеличивает счётчик."), analyticsText("Пропущенный этап и незавершённая работа не считаются потерей клиента."));
  if (data.sales?.plan) {
    const plan = data.sales.plan;
    lines.push(planExplanation(plan));
    if (plan.status === "ready") lines.push(`${analyticsText("План / факт за выбранный период")}: ${plan.label} / ${plan.actual?.label || "—"} (${plan.percent == null ? "—" : `${plan.percent}%`})`);
  }
  return lines;
}

function csvEscape(value: unknown) {
  const s = String(value ?? "");
  if (/[",\n;]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadBlob(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function fileBase(data: any) {
  const from = data.period?.dateFrom || (data.period?.from || "").slice(0, 10) || "all";
  const to = data.period?.dateTo || (data.period?.to || "").slice(0, 10) || "now";
  return `CREOLAB_CRM_Report_${from}_${to}`;
}

export function exportAnalyticsCsv(data: any, table: "sources" | "services" | "losses" | "funnel") {
  let rows: string[][] = [];
  if (table === "sources") {
    rows = [
      [uiText("Источник"), uiText("Обращения"), uiText("Сделки"), uiText("Продажи"), analyticsText("Успешность закрытых сделок"), uiText("Сумма продаж")],
      ...(data.sources || []).map((r: any) => [
        r.name,
        r.inquiries,
        r.deals,
        r.won,
        r.conversion ?? "",
        r.revenueExact ?? r.revenue ?? "",
      ]),
    ];
  } else if (table === "services") {
    rows = [
      [uiText("Услуга"), uiText("Обращения"), uiText("Продажи"), analyticsText("Успешность закрытых сделок"), uiText("Сумма продаж")],
      ...(data.services || []).map((r: any) => [
        r.name,
        r.inquiries,
        r.won,
        r.conversion ?? "",
        r.revenueExact ?? r.revenue ?? "",
      ]),
    ];
  } else if (table === "losses") {
    rows = [
      [uiText("Причина"), uiText("Количество")],
      ...(data.losses?.reasons || []).map((r: any) => [r.reason, r.count]),
    ];
  } else {
    rows = [
      [uiText("Этап"), uiText("Количество"), uiText("От начала %")],
      ...(data.funnel?.steps || []).map((r: any) => [r.name, r.count, r.fromStartPct ?? ""]),
    ];
  }
  const coverage = [...analyticsCoverageLines(data), ...financialReportLines(data)];
  if (coverage.length) rows.unshift(...coverage.map(line => [line]), []);
  const body = rows.map((row) => row.map(csvEscape).join(";")).join("\n");
  downloadBlob(`${fileBase(data)}_${table}.csv`, "\uFEFF" + body, "text/csv;charset=utf-8");
}

export function exportAnalyticsExcel(data: any, sections: ReportSections) {
  const sheets: string[] = [];
  const pushSheet = (name: string, headers: string[], rows: unknown[][]) => {
    const cells = (row: unknown[]) => `<Row>${row.map(value => `<Cell><Data ss:Type="String">${esc(value)}</Data></Cell>`).join("")}</Row>`;
    const head = cells(headers);
    const body = rows.map(cells).join("");
    sheets.push(
      `<Worksheet ss:Name="${esc(name)}"><Table>${head}${body}</Table></Worksheet>`,
    );
  };

  const coverage = [...analyticsCoverageLines(data), ...financialReportLines(data)];
  if (coverage.length) pushSheet(uiText("Охват данных"), [uiText("Примечание")], coverage.map(line => [line]));

  if (sections.overview) {
    const o = data.overview || {};
    pushSheet(
      uiText("Обзор"),
      [uiText("Показатель"), uiText("Значение")],
      [
        [uiText("Период"), data.period?.label],
        [uiText("Фильтры"), data.filters?.label || "—"],
        [uiText("Обращения"), o.inquiries],
        [uiText("Клиенты"), o.clients],
        [uiText("Сделки"), o.dealsCreated],
        [uiText("Договоры"), o.contracts],
        [uiText("Продажи"), o.won],
        [uiText("Потери"), o.lost],
        [uiText("Сумма продаж"), o.revenueLabel],
        [uiText("Подтверждённые оплаты"), o.receiptsLabel],
        [analyticsText("Успешность закрытых сделок"), o.conversion != null ? `${o.conversion}%` : "—"],
        [uiText("Средний чек"), o.avgCheckLabel],
      ],
    );
  }
  if (sections.funnel) {
    pushSheet(
      uiText("Этапы"),
      [uiText("Этап"), uiText("Количество"), uiText("От начала %")],
      (data.funnel?.steps || []).map((s: any) => [s.name, s.count, s.fromStartPct]),
    );
  }
  if (sections.sources) {
    pushSheet(
      uiText("Источники"),
      [uiText("Источник"), uiText("Обращения"), uiText("Сделки"), uiText("Продажи"), analyticsText("Успешность закрытых сделок"), uiText("Сумма продаж")],
      (data.sources || []).map((r: any) => [r.name, r.inquiries, r.deals, r.won, r.conversion, r.revenueLabel]),
    );
  }
  if (sections.services) {
    pushSheet(
      uiText("Услуги"),
      [uiText("Услуга"), uiText("Обращения"), uiText("Продажи"), analyticsText("Успешность закрытых сделок"), uiText("Сумма продаж")],
      (data.services || []).map((r: any) => [r.name, r.inquiries, r.won, r.conversion, r.revenueLabel]),
    );
  }
  if (sections.sales) {
    const s = data.sales || {};
    pushSheet(
      uiText("Продажи"),
      [uiText("Показатель"), uiText("Значение")],
      [
        [uiText("Продажи"), s.won],
        [uiText("Сумма продаж"), s.revenueLabel],
        [uiText("Подтверждённые оплаты"), s.receiptsLabel],
        [uiText("Средний чек"), s.avgCheckLabel],
        [uiText("Медианный чек"), s.medianCheckLabel],
        [uiText("Макс. сделка"), s.maxCheckLabel],
        [uiText("В работе"), s.pipelineLabel],
        [uiText("Средний цикл, дн."), s.cycle?.avgDays],
        [uiText("Медианный цикл, дн."), s.cycle?.medianDays],
      ],
    );
  }
  if (sections.losses) {
    pushSheet(
      uiText("Потери"),
      [uiText("Причина"), uiText("Количество")],
      (data.losses?.reasons || []).map((r: any) => [r.reason, r.count]),
    );
    pushSheet(
      uiText("Потери по стадиям"),
      [uiText("Стадия"), uiText("Потеряно"), uiText("Потенциал")],
      (data.losses?.byStage || []).map((r: any) => [r.stage, r.count, r.amountLabel]),
    );
  }

  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
${sheets.join("\n")}
</Workbook>`;
  downloadBlob(`${fileBase(data)}.xls`, xml, "application/vnd.ms-excel");
}

export function exportAnalyticsPdf(data: any, sections: ReportSections) {
  const o = data.overview || {};
  const parts: string[] = [];
  parts.push(`<h1>CREOLAB CRM</h1>`);
  parts.push(`<p class="sub">${esc(uiText("Период"))}: ${esc(data.period?.label || "")}</p>`);
  if (data.filters?.label) parts.push(`<p class="sub">${esc(uiText("Фильтры"))}: ${esc(data.filters.label)}</p>`);
  for (const line of [...analyticsCoverageLines(data), ...financialReportLines(data)]) parts.push(`<p class="sub">${esc(line)}</p>`);

  const metrics = (title: string, rows: Array<[string, unknown]>) => parts.push(`<h2>${esc(title)}</h2><ul>${rows.map(([label, value]) => `<li>${esc(label)}: <b>${esc(value ?? "—")}</b></li>`).join("")}</ul>`);
  const table = (title: string, headers: string[]) => parts.push(`<h2>${esc(title)}</h2><table><thead><tr>${headers.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>`);
  if (sections.overview) metrics(uiText("Обзор"), [
    [uiText("Обращения"), o.inquiries], [uiText("Клиенты"), o.clients], [uiText("Сделки"), o.dealsCreated],
    [uiText("Договоры"), o.contracts], [uiText("Продажи"), o.won], [uiText("Сумма продаж"), o.revenueLabel],
    [uiText("Подтверждённые оплаты"), o.receiptsLabel], [analyticsText("Успешность закрытых сделок"), o.conversion != null ? `${o.conversion}%` : "—"],
    [uiText("Средний чек"), o.avgCheckLabel], [uiText("Потеряно"), o.lost],
  ]);
  if (sections.funnel) {
    table(uiText("Этапы"), [uiText("Этап"), uiText("Количество"), uiText("От начала %")]);
    for (const step of data.funnel?.steps || []) parts.push(`<tr><td>${esc(step.name)}</td><td>${esc(step.count)}</td><td>${step.fromStartPct != null ? esc(step.fromStartPct) + "%" : "—"}</td></tr>`);
    parts.push(`</tbody></table>`);
  }
  for (const section of ["sources", "services"] as const) {
    if (!sections[section]) continue;
    table(section === "sources" ? uiText("Источники") : uiText("Услуги"), [section === "sources" ? uiText("Источник") : uiText("Услуга"), uiText("Обращения"), uiText("Продажи"), analyticsText("Успешность закрытых сделок"), uiText("Сумма продаж")]);
    for (const row of data[section] || []) parts.push(`<tr><td>${esc(row.name)}</td><td>${esc(row.inquiries)}</td><td>${esc(row.won)}</td><td>${row.conversion != null ? esc(row.conversion) + "%" : "—"}</td><td>${esc(row.revenueLabel)}</td></tr>`);
    parts.push(`</tbody></table>`);
  }
  if (sections.sales) {
    const sale = data.sales || {};
    metrics(uiText("Продажи"), [[uiText("Продажи"), sale.won], [uiText("Сумма продаж"), sale.revenueLabel], [uiText("Подтверждённые оплаты"), sale.receiptsLabel],
      [uiText("Средний чек"), sale.avgCheckLabel], [uiText("Медианный чек"), sale.medianCheckLabel],
      [uiText("Средний цикл, дн."), sale.cycle?.avgDays], [uiText("Медианный цикл, дн."), sale.cycle?.medianDays]]);
  }
  if (sections.losses) {
    table(uiText("Потери"), [uiText("Причина"), uiText("Количество")]);
    for (const row of data.losses?.reasons || []) parts.push(`<tr><td>${esc(row.reason)}</td><td>${esc(row.count)}</td></tr>`);
    parts.push(`</tbody></table>`);
  }
  if (data.biggestLoss) metrics(uiText("Потери"), [[`${data.biggestLoss.from} → ${data.biggestLoss.to}`, data.biggestLoss.lost]]);

  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"/><title>${esc(fileBase(data))}</title>
<style>
  body{font-family:Georgia,serif;color:#111;margin:32px;line-height:1.45}
  h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:24px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
  .sub{color:#555;margin:2px 0} table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}
  th,td{border:1px solid #ccc;padding:6px 8px;text-align:left} th{background:#f4f4f4}
  ul{padding-left:18px} @media print{body{margin:12mm}}
</style></head><body>${parts.join("\n")}</body></html>`;

  const w = window.open("", "_blank");
  if (!w) {
    downloadBlob(`${fileBase(data)}.html`, html, "text/html;charset=utf-8");
    return;
  }
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}
