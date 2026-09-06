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
      ["Источник", "Обращения", "Сделки", "Продажи", "Конверсия", "Выручка"],
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
      ["Услуга", "Обращения", "Продажи", "Конверсия", "Выручка"],
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
      ["Причина", "Количество"],
      ...(data.losses?.reasons || []).map((r: any) => [r.reason, r.count]),
    ];
  } else {
    rows = [
      ["Переход", "Было", "Перешло", "Потеря", "Конверсия"],
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
      "Обзор",
      ["Показатель", "Значение"],
      [
        ["Период", data.period?.label],
        ["Фильтры", data.filters?.label || "—"],
        ["Обращения", o.inquiries],
        ["Клиенты", o.clients],
        ["Сделки", o.dealsCreated],
        ["Договоры", o.contracts],
        ["Продажи", o.won],
        ["Потери", o.lost],
        ["Выручка", o.revenueLabel],
        ["Конверсия", o.conversion != null ? `${o.conversion}%` : "—"],
        ["Средний чек", o.avgCheckLabel],
      ],
    );
  }
  if (sections.funnel) {
    pushSheet(
      "Воронка",
      ["Этап", "Количество", "От начала %", "От предыдущего %"],
      (data.funnel?.steps || []).map((s: any) => [s.name, s.count, s.fromStartPct, s.fromPrevPct]),
    );
  }
  if (sections.sources) {
    pushSheet(
      "Источники",
      ["Источник", "Обращения", "Сделки", "Продажи", "Конверсия", "Выручка"],
      (data.sources || []).map((r: any) => [r.name, r.inquiries, r.deals, r.won, r.conversion, r.revenueLabel]),
    );
  }
  if (sections.services) {
    pushSheet(
      "Услуги",
      ["Услуга", "Обращения", "Продажи", "Конверсия", "Выручка"],
      (data.services || []).map((r: any) => [r.name, r.inquiries, r.won, r.conversion, r.revenueLabel]),
    );
  }
  if (sections.sales) {
    const s = data.sales || {};
    pushSheet(
      "Продажи",
      ["Показатель", "Значение"],
      [
        ["WON", s.won],
        ["Продано", s.revenueLabel],
        ["Средний чек", s.avgCheckLabel],
        ["Медианный чек", s.medianCheckLabel],
        ["Макс. сделка", s.maxCheckLabel],
        ["Pipeline", s.pipelineLabel],
        ["Взвешенный pipeline", s.weightedPipelineLabel],
        ["Средний цикл, дн.", s.cycle?.avgDays],
        ["Медианный цикл, дн.", s.cycle?.medianDays],
      ],
    );
  }
  if (sections.losses) {
    pushSheet(
      "Потери",
      ["Причина", "Количество"],
      (data.losses?.reasons || []).map((r: any) => [r.reason, r.count]),
    );
    pushSheet(
      "Потери по стадиям",
      ["Стадия", "Потеряно", "Потенциал"],
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
  parts.push(`<p class="sub">Отчёт за ${esc(data.period?.label || "")}</p>`);
  if (data.filters?.label) parts.push(`<p class="sub">Фильтры: ${esc(data.filters.label)}</p>`);

  if (sections.overview) {
    parts.push(`<h2>1. Основные результаты</h2><ul>
      <li>Обращения: <b>${esc(o.inquiries)}</b></li>
      <li>Клиенты: <b>${esc(o.clients)}</b></li>
      <li>Сделки: <b>${esc(o.dealsCreated)}</b></li>
      <li>Договоры: <b>${esc(o.contracts)}</b></li>
      <li>Продажи: <b>${esc(o.won)}</b></li>
      <li>Выручка: <b>${esc(o.revenueLabel || "—")}</b></li>
      <li>Конверсия: <b>${o.conversion != null ? esc(o.conversion) + "%" : "—"}</b></li>
      <li>Средний чек: <b>${esc(o.avgCheckLabel || "—")}</b></li>
      <li>Потеряно: <b>${esc(o.lost)}</b></li>
    </ul>`);
  }
  if (sections.funnel) {
    parts.push(`<h2>2. Воронка</h2><table><thead><tr><th>Этап</th><th>Кол-во</th><th>От начала</th></tr></thead><tbody>`);
    for (const s of data.funnel?.steps || []) {
      parts.push(
        `<tr><td>${esc(s.name)}</td><td>${esc(s.count)}</td><td>${s.fromStartPct != null ? esc(s.fromStartPct) + "%" : "—"}</td></tr>`,
      );
    }
    parts.push(`</tbody></table>`);
    if (data.biggestLoss) {
      parts.push(
        `<p><b>Наибольшая потеря:</b> ${esc(data.biggestLoss.from)} → ${esc(data.biggestLoss.to)} (${esc(data.biggestLoss.lost)})</p>`,
      );
    }
  }
  if (sections.sources) {
    parts.push(`<h2>3. Источники</h2><table><thead><tr><th>Источник</th><th>Обращения</th><th>Продажи</th><th>Конверсия</th><th>Выручка</th></tr></thead><tbody>`);
    for (const r of data.sources || []) {
      parts.push(
        `<tr><td>${esc(r.name)}</td><td>${esc(r.inquiries)}</td><td>${esc(r.won)}</td><td>${r.conversion != null ? esc(r.conversion) + "%" : "—"}</td><td>${esc(r.revenueLabel)}</td></tr>`,
      );
    }
    parts.push(`</tbody></table>`);
  }
  if (sections.services) {
    parts.push(`<h2>4. Услуги</h2><table><thead><tr><th>Услуга</th><th>Обращения</th><th>Продажи</th><th>Конверсия</th><th>Выручка</th></tr></thead><tbody>`);
    for (const r of data.services || []) {
      parts.push(
        `<tr><td>${esc(r.name)}</td><td>${esc(r.inquiries)}</td><td>${esc(r.won)}</td><td>${r.conversion != null ? esc(r.conversion) + "%" : "—"}</td><td>${esc(r.revenueLabel)}</td></tr>`,
      );
    }
    parts.push(`</tbody></table>`);
  }
  if (sections.sales) {
    const s = data.sales || {};
    parts.push(`<h2>5. Продажи</h2><ul>
      <li>WON: ${esc(s.won)}</li>
      <li>Выручка: ${esc(s.revenueLabel || "—")}</li>
      <li>Средний / медианный чек: ${esc(s.avgCheckLabel || "—")} / ${esc(s.medianCheckLabel || "—")}</li>
      <li>Цикл продажи: ср. ${esc(s.cycle?.avgDays ?? "—")} дн., мед. ${esc(s.cycle?.medianDays ?? "—")} дн.</li>
    </ul>`);
  }
  if (sections.losses) {
    parts.push(`<h2>6. Причины потерь</h2><table><thead><tr><th>Причина</th><th>Кол-во</th></tr></thead><tbody>`);
    for (const r of data.losses?.reasons || []) {
      parts.push(`<tr><td>${esc(r.reason)}</td><td>${esc(r.count)}</td></tr>`);
    }
    parts.push(`</tbody></table>`);
  }
  parts.push(`<h2>Основные выводы</h2>`);
  if (data.biggestLoss) {
    parts.push(
      `<p>Наибольшая потеря наблюдается между «${esc(data.biggestLoss.from)}» и «${esc(data.biggestLoss.to)}» (${esc(data.biggestLoss.lost)}).</p>`,
    );
  } else {
    parts.push(`<p>Недостаточно данных для автоматических выводов.</p>`);
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
