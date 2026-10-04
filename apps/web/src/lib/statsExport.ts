import { uiText, useUiText, localizeUiOptions } from "./uiText";
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
  const from = (data.period?.from || "").slice(0, 10) || "all";
  const to = (data.period?.to || "").slice(0, 10) || "now";
  return `CREOLAB_CRM_Report_${from}_${to}`;
}

export function exportAnalyticsCsv(data: any, table: "sources" | "services" | "losses" | "funnel") {
  let rows: string[][] = [];
  if (table === "sources") {
    rows = [
      [uiText("Источник"), uiText("Обращения"), uiText("Сделки"), uiText("Продажи"), uiText("Конверсия"), uiText("Выручка")],
      ...(data.sources || []).map((r: any) => [
        r.name,
        r.inquiries,
        r.deals,
        r.won,
        r.conversion ?? "",
        r.revenue ?? "",
      ]),
    ];
  } else if (table === "services") {
    rows = [
      [uiText("Услуга"), uiText("Обращения"), uiText("Продажи"), uiText("Конверсия"), uiText("Выручка")],
      ...(data.services || []).map((r: any) => [
        r.name,
        r.inquiries,
        r.won,
        r.conversion ?? "",
        r.revenue ?? "",
      ]),
    ];
  } else if (table === "losses") {
    rows = [
      [uiText("Причина"), uiText("Количество")],
      ...(data.losses?.reasons || []).map((r: any) => [r.reason, r.count]),
    ];
  } else {
    rows = [
      [uiText("Переход"), uiText("Было"), uiText("Перешло"), uiText("Потеря"), uiText("Конверсия")],
      ...(data.funnel?.transitions || []).map((r: any) => [
        `${r.from} → ${r.to}`,
        r.was,
        r.passed,
        r.lost,
        r.conversion ?? "",
      ]),
    ];
  }
  const body = rows.map((row) => row.map(csvEscape).join(";")).join("\n");
  downloadBlob(`${fileBase(data)}_${table}.csv`, "\uFEFF" + body, "text/csv;charset=utf-8");
}

export function exportAnalyticsExcel(data: any, sections: ReportSections) {
  const sheets: string[] = [];
  const pushSheet = (name: string, headers: string[], rows: unknown[][]) => {
    const head = `<tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
    const body = rows.map((row) => `<tr>${row.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
    sheets.push(
      `<Worksheet ss:Name="${esc(name)}"><Table>${head}${body}</Table></Worksheet>`,
    );
  };

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
        [uiText("Выручка"), o.revenueLabel],
        [uiText("Конверсия"), o.conversion != null ? `${o.conversion}%` : "—"],
        [uiText("Средний чек"), o.avgCheckLabel],
      ],
    );
  }
  if (sections.funnel) {
    pushSheet(
      uiText("Этапы"),
      [uiText("Этап"), uiText("Количество"), uiText("От начала %"), uiText("От предыдущего %")],
      (data.funnel?.steps || []).map((s: any) => [s.name, s.count, s.fromStartPct, s.fromPrevPct]),
    );
  }
  if (sections.sources) {
    pushSheet(
      uiText("Источники"),
      [uiText("Источник"), uiText("Обращения"), uiText("Сделки"), uiText("Продажи"), uiText("Конверсия"), uiText("Выручка")],
      (data.sources || []).map((r: any) => [r.name, r.inquiries, r.deals, r.won, r.conversion, r.revenueLabel]),
    );
  }
  if (sections.services) {
    pushSheet(
      uiText("Услуги"),
      [uiText("Услуга"), uiText("Обращения"), uiText("Продажи"), uiText("Конверсия"), uiText("Выручка")],
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
        [uiText("Продано"), s.revenueLabel],
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
  parts.push(uiText("<p class=\"sub\">Отчёт за {p0}</p>", {p0: esc(data.period?.label || "")}));
  if (data.filters?.label) parts.push(uiText("<p class=\"sub\">Фильтры: {p0}</p>", {p0: esc(data.filters.label)}));

  if (sections.overview) {
    parts.push(uiText("<h2>1. Основные результаты</h2><ul>\n      <li>Обращения: <b>{p0}</b></li>\n      <li>Клиенты: <b>{p1}</b></li>\n      <li>Сделки: <b>{p2}</b></li>\n      <li>Договоры: <b>{p3}</b></li>\n      <li>Продажи: <b>{p4}</b></li>\n      <li>Выручка: <b>{p5}</b></li>\n      <li>Конверсия: <b>{p6}</b></li>\n      <li>Средний чек: <b>{p7}</b></li>\n      <li>Потеряно: <b>{p8}</b></li>\n    </ul>", {p0: esc(o.inquiries), p1: esc(o.clients), p2: esc(o.dealsCreated), p3: esc(o.contracts), p4: esc(o.won), p5: esc(o.revenueLabel || "—"), p6: o.conversion != null ? esc(o.conversion) + "%" : "—", p7: esc(o.avgCheckLabel || "—"), p8: esc(o.lost)}));
  }
  if (sections.funnel) {
    parts.push(uiText("<h2>2. Этапы</h2><table><thead><tr><th>Этап</th><th>Кол-во</th><th>От начала</th></tr></thead><tbody>"));
    for (const s of data.funnel?.steps || []) {
      parts.push(
        `<tr><td>${esc(s.name)}</td><td>${esc(s.count)}</td><td>${s.fromStartPct != null ? esc(s.fromStartPct) + "%" : "—"}</td></tr>`,
      );
    }
    parts.push(`</tbody></table>`);
    if (data.biggestLoss) {
      parts.push(
        uiText("<p><b>Наибольшая потеря:</b> {p0} → {p1} ({p2})</p>", {p0: esc(data.biggestLoss.from), p1: esc(data.biggestLoss.to), p2: esc(data.biggestLoss.lost)}),
      );
    }
  }
  if (sections.sources) {
    parts.push(uiText("<h2>3. Источники</h2><table><thead><tr><th>Источник</th><th>Обращения</th><th>Продажи</th><th>Конверсия</th><th>Выручка</th></tr></thead><tbody>"));
    for (const r of data.sources || []) {
      parts.push(
        `<tr><td>${esc(r.name)}</td><td>${esc(r.inquiries)}</td><td>${esc(r.won)}</td><td>${r.conversion != null ? esc(r.conversion) + "%" : "—"}</td><td>${esc(r.revenueLabel)}</td></tr>`,
      );
    }
    parts.push(`</tbody></table>`);
  }
  if (sections.services) {
    parts.push(uiText("<h2>4. Услуги</h2><table><thead><tr><th>Услуга</th><th>Обращения</th><th>Продажи</th><th>Конверсия</th><th>Выручка</th></tr></thead><tbody>"));
    for (const r of data.services || []) {
      parts.push(
        `<tr><td>${esc(r.name)}</td><td>${esc(r.inquiries)}</td><td>${esc(r.won)}</td><td>${r.conversion != null ? esc(r.conversion) + "%" : "—"}</td><td>${esc(r.revenueLabel)}</td></tr>`,
      );
    }
    parts.push(`</tbody></table>`);
  }
  if (sections.sales) {
    const s = data.sales || {};
    parts.push(uiText("<h2>5. Продажи</h2><ul>\n      <li>Продажи: {p0}</li>\n      <li>Выручка: {p1}</li>\n      <li>Средний / медианный чек: {p2} / {p3}</li>\n      <li>Цикл продажи: ср. {p4} дн., мед. {p5} дн.</li>\n    </ul>", {p0: esc(s.won), p1: esc(s.revenueLabel || "—"), p2: esc(s.avgCheckLabel || "—"), p3: esc(s.medianCheckLabel || "—"), p4: esc(s.cycle?.avgDays ?? "—"), p5: esc(s.cycle?.medianDays ?? "—")}));
  }
  if (sections.losses) {
    parts.push(uiText("<h2>6. Причины потерь</h2><table><thead><tr><th>Причина</th><th>Кол-во</th></tr></thead><tbody>"));
    for (const r of data.losses?.reasons || []) {
      parts.push(`<tr><td>${esc(r.reason)}</td><td>${esc(r.count)}</td></tr>`);
    }
    parts.push(`</tbody></table>`);
  }
  parts.push(uiText("<h2>Основные выводы</h2>"));
  if (data.biggestLoss) {
    parts.push(
      uiText("<p>Наибольшая потеря наблюдается между «{p0}» и «{p1}» ({p2}).</p>", {p0: esc(data.biggestLoss.from), p1: esc(data.biggestLoss.to), p2: esc(data.biggestLoss.lost)}),
    );
  } else {
    parts.push(uiText("<p>Недостаточно данных для автоматических выводов.</p>"));
  }

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
