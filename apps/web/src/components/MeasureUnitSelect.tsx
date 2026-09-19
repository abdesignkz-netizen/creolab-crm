import { esfMeasureUnitSymbol } from "@creolab/contracts";

const UNITS = [
  { value: "шт", label: "шт" },
  { value: "услуга", label: "услуга" },
  { value: "час", label: "час" },
  { value: "сут", label: "сутки" },
  { value: "мес", label: "мес" },
  { value: "год", label: "год" },
  { value: "кг", label: "кг" },
  { value: "т", label: "т" },
  { value: "м", label: "м" },
  { value: "м2", label: "м²" },
  { value: "компл", label: "компл." },
  { value: "упак", label: "упак" },
];

export function MeasureUnitSelect({
  value,
  onChange,
  disabled,
  id,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (unit: string) => void;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const selected = esfMeasureUnitSymbol(value);
  const known = UNITS.some((unit) => unit.value === selected);
  return (
    <select
      id={id}
      disabled={disabled}
      aria-label={ariaLabel || "Единица измерения"}
      value={known ? selected : value || "шт"}
      onChange={(event) => onChange(event.target.value)}
    >
      {!known && value ? <option value={value}>{selected}</option> : null}
      {UNITS.map((unit) => (
        <option key={unit.value} value={unit.value}>
          {unit.label}
        </option>
      ))}
    </select>
  );
}
