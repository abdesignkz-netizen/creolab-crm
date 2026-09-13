import {
  ESF_MEASURE_UNIT_GROUPS,
  ESF_MEASURE_UNITS,
  esfMeasureUnitOptionLabel,
  findEsfMeasureUnit,
  resolveEsfMeasureUnitCode,
} from "@creolab/contracts";

type Props = {
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  id?: string;
  name?: string;
  "aria-label"?: string;
};

export function EsfMeasureUnitSelect({
  value,
  onChange,
  disabled,
  required,
  invalid,
  id,
  name,
  "aria-label": ariaLabel,
}: Props) {
  const selected = resolveEsfMeasureUnitCode(value);
  const extra = !findEsfMeasureUnit(selected);
  return (
    <select
      className="esf-measure-unit"
      id={id}
      name={name}
      required={required}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-label={ariaLabel || "Единица измерения"}
      title="Код единицы измерения из классификатора ИС ЭСФ (ОКЕИ)"
      value={selected}
      onChange={(event) => onChange(event.target.value)}
    >
      {extra ? <option value={selected}>{selected} — код из документа</option> : null}
      {ESF_MEASURE_UNIT_GROUPS.map((group) => (
        <optgroup key={group.id} label={group.label}>
          {ESF_MEASURE_UNITS.filter((unit) => unit.group === group.id).map((unit) => (
            <option key={unit.code} value={unit.code}>
              {esfMeasureUnitOptionLabel(unit)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
