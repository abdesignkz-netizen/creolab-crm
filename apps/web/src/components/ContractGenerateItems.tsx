import { uiText, useUiText, localizeUiOptions, uiFormatLocale } from "../lib/uiText";
import { MeasureUnitSelect } from "./MeasureUnitSelect";

export type ContractDraftLine = {
  key: string;
  name: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  vatRate: string;
};

export function newContractDraftLine(name = ""): ContractDraftLine {
  return {
    key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    quantity: "1",
    unit: "шт",
    unitPrice: "",
    vatRate: "0",
  };
}

export function parseContractDraftLines(lines: ContractDraftLine[]) {
  const items = [];
  for (const line of lines) {
    const name = line.name.trim();
    if (!name) continue;
    const quantity = Number(String(line.quantity).replace(",", "."));
    const unitPrice = Number(String(line.unitPrice).replace(/\s+/g, "").replace(",", ".")) || 0;
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(uiText("Укажите количество для «{p0}»", {p0: name}));
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new Error(uiText("Укажите цену для «{p0}»", {p0: name}));
    }
    items.push({
      name,
      quantity,
      unit: line.unit,
      unitPrice,
      vatRate: Number(line.vatRate) || 0,
    });
  }
  if (!items.length) throw new Error(uiText("Добавьте хотя бы одну услугу или товар"));
  return items;
}

function lineSum(line: ContractDraftLine) {
  const quantity = Number(String(line.quantity).replace(",", ".")) || 0;
  const unitPrice = Number(String(line.unitPrice).replace(/\s+/g, "").replace(",", ".")) || 0;
  const vat = Number(line.vatRate) || 0;
  return Math.round(quantity * unitPrice * (1 + vat / 100) * 100) / 100;
}

export function ContractGenerateItems({
  lines,
  onChange,
  disabled,
  completionTerms,
  onCompletionTermsChange,
}: {
  lines: ContractDraftLine[];
  onChange: (lines: ContractDraftLine[]) => void;
  disabled?: boolean;
  completionTerms: string;
  onCompletionTermsChange: (value: string) => void;
}) {
  const uiText = useUiText();
  const total = lines.reduce((sum, line) => sum + lineSum(line), 0);
  function patch(key: string, next: Partial<ContractDraftLine>) {
    onChange(lines.map((line) => (line.key === key ? { ...line, ...next } : line)));
  }
  return (
    <div className="contract-gen-items">
      <div className="saved-editor-summary">
        <div>
          <b>{uiText("Услуги и товары")}</b>
          <p className="muted">{uiText("Попадут в договор, счёт и АВР. НДС выбирается в каждой строке.")}</p>
        </div>
        <button
          type="button"
          className="btn secondary"
          disabled={disabled}
          onClick={() => onChange([...lines, newContractDraftLine()])}
        >
          {uiText("Добавить позицию")}</button>
      </div>
      {lines.map((line, index) => (
        <div className="contract-gen-line" key={line.key}>
          <label>
            {uiText("Услуга / товар")}<input
              value={line.name}
              disabled={disabled}
              placeholder={uiText("Разработка презентации")}
              onChange={(e) => patch(line.key, { name: e.target.value })}
            />
          </label>
          <label>
            {uiText("Кол-во")}<input value={line.quantity} disabled={disabled} onChange={(e) => patch(line.key, { quantity: e.target.value })} />
          </label>
          <label>
            {uiText("Ед. изм.")}<MeasureUnitSelect
              value={line.unit}
              disabled={disabled}
              aria-label={uiText("Единица измерения {p0}", {p0: index + 1})}
              onChange={(unit) => patch(line.key, { unit })}
            />
          </label>
          <label>
            {uiText("Цена без НДС (₸)")}<input
              value={line.unitPrice}
              disabled={disabled}
              placeholder="0"
              onChange={(e) => patch(line.key, { unitPrice: e.target.value })}
            />
          </label>
          <label>
            {uiText("НДС")}<select
              aria-label={uiText("НДС {p0}", {p0: index + 1})}
              disabled={disabled}
              value={line.vatRate}
              onChange={(e) => patch(line.key, { vatRate: e.target.value })}
            >
              <option value="0">{uiText("Без НДС")}</option>
              <option value="12">{uiText("С НДС (12%)")}</option>
            </select>
          </label>
          {lines.length > 1 ? (
            <button
              type="button"
              className="btn secondary"
              disabled={disabled}
              onClick={() => onChange(lines.filter((row) => row.key !== line.key))}
            >
              {uiText("Убрать")}</button>
          ) : null}
        </div>
      ))}
      <p className="contract-gen-total">
        {uiText("Итого:")}{" "}<b>{total.toLocaleString(uiFormatLocale())} ₸</b>
      </p>
      <label>
        {uiText("Срок выполнения работ / оказания услуг")}<textarea
          value={completionTerms}
          onChange={(event) => onCompletionTermsChange(event.target.value)}
          disabled={disabled}
          maxLength={2000}
          rows={2}
          placeholder={uiText("Например: 10 рабочих дней после предоплаты или до 15.10.2026")}
        />
      </label>
      <p className="muted">{uiText("Срок для всех позиций договора. Если не заполнить — по согласованию сторон.")}</p>
    </div>
  );
}
