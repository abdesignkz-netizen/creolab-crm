import { useEffect, useState } from "react";
import { applyDocumentLocale, getPublicLocale, rememberLocale, type Locale } from "../i18n";

export function useAuthLocale() {
  const [locale, setLocale] = useState(getPublicLocale);
  useEffect(() => applyDocumentLocale(locale), [locale]);
  function chooseLocale(next: Locale) {
    rememberLocale(next);
    setLocale(next);
  }
  return [locale, chooseLocale] as const;
}

export function AuthLanguagePicker({ locale, onChange }: { locale: Locale; onChange: (locale: Locale) => void }) {
  return (
    <div className="auth-language-picker" role="group" aria-label={locale === "kk" ? "Тіл" : locale === "en" ? "Language" : "Язык"}>
      {([['kk', 'Қазақша'], ['ru', 'Русский'], ['en', 'English']] as const).map(([value, label]) => (
        <button key={value} type="button" lang={value} aria-pressed={locale === value} onClick={() => onChange(value)}>
          {label}
        </button>
      ))}
    </div>
  );
}
