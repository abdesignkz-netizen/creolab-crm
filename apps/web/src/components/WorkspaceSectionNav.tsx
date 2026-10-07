type SectionOption<T extends string> = { id: T; label: string };

/** The same section choice stays visible on narrow and wide screens. */
export function WorkspaceSectionNav<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: SectionOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <>
      <nav className="workspace-section-nav" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={value === option.id ? "btn" : "btn secondary"}
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </nav>
      <label className="workspace-section-select">
        {label}
        <select
          value={value}
          onChange={(event) => onChange(event.target.value as T)}
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}
