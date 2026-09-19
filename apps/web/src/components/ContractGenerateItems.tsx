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
      throw new Error(`Укажите количество для «${name}»`);
    }
    if (!Number.isFinite(unitPrice) || unitPrice < 0) {
      throw new Error(`Укажите цену для «${name}»`);
    }
    items.push({
      name,
      quantity,
      unit: line.unit,
      unitPrice,
      vatRate: Number(line.vatRate) || 0,
    });
  }
  if (!items.length) throw new Error("Добавьте хотя бы одну услугу или товар");
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
}: {
  lines: ContractDraftLine[];
  onChange: (lines: ContractDraftLine[]) => void;
  disabled?: boolean;
}) {
  const total = lines.reduce((sum, line) => sum + lineSum(line), 0);
  function patch(key: string, next: Partial<ContractDraftLine>) {
    onChange(lines.map((line) => (line.key === key ? { ...line, ...next } : line)));
  }
  return (
    <div className="contract-gen-items">
      <div className="saved-editor-summary">
        <div>
          <b>Услуги и товары</b>
          <p className="muted">Попадут в договор, счёт и АВР. НДС выбирается в каждой строке.</p>
        </div>
        <button
          type="button"
          className="btn secondary"
          disabled={disabled}
          onClick={() => onChange([...lines, newContractDraftLine()])}
        >
          Добавить позицию
        </button>
      </div>
      {lines.map((line, index) => (
        <div className="contract-gen-line" key={line.key}>
          <label>
            Услуга / товар
            <input
              value={line.name}
              disabled={disabled}
              placeholder="Разработка презентации"
              onChange={(e) => patch(line.key, { name: e.target.value })}
            />
          </label>
          <label>
            Кол-во
            <input value={line.quantity} disabled={disabled} onChange={(e) => patch(line.key, { quantity: e.target.value })} />
          </label>
          <label>
            Ед. изм.
            <MeasureUnitSelect
              value={line.unit}
              disabled={disabled}
              aria-label={`Единица измерения ${index + 1}`}
              onChange={(unit) => patch(line.key, { unit })}
            />
          </label>
          <label>
            Цена без НДС (₸)
            <input
              value={line.unitPrice}
              disabled={disabled}
              placeholder="0"
              onChange={(e) => patch(line.key, { unitPrice: e.target.value })}
            />
          </label>
          <label>
            НДС
            <select
              aria-label={`НДС ${index + 1}`}
              disabled={disabled}
              value={line.vatRate}
              onChange={(e) => patch(line.key, { vatRate: e.target.value })}
            >
              <option value="0">Без НДС</option>
              <option value="12">С НДС (12%)</option>
            </select>
          </label>
          {lines.length > 1 ? (
            <button
              type="button"
              className="btn secondary"
              disabled={disabled}
              onClick={() => onChange(lines.filter((row) => row.key !== line.key))}
            >
              Убрать
            </button>
          ) : null}
        </div>
      ))}
      <p className="contract-gen-total">
        Итого: <b>{total.toLocaleString("ru-RU")} ₸</b>
      </p>
    </div>
  );
}
