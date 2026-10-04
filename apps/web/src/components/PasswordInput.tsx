import { useState, type InputHTMLAttributes } from "react";

import { useLocale } from "../lib/session";
import { t, type Locale } from "../i18n";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { locale?: Locale };

export function PasswordInput({ className = "", locale: selectedLocale, ...props }: PasswordInputProps) {
  const sessionLocale = useLocale();
  const locale = selectedLocale ?? sessionLocale;
  const [visible, setVisible] = useState(false);
  return (
    <span className="password-field">
      <input {...props} className={className} type={visible ? "text" : "password"} />
      <button
        type="button"
        className="password-toggle"
        aria-label={t(locale, visible ? "password.hideLabel" : "password.showLabel")}
        aria-pressed={visible}
        title={t(locale, visible ? "password.hideLabel" : "password.showLabel")}
        onClick={() => setVisible(value => !value)}
      >
        {t(locale, visible ? "password.hide" : "password.show")}
      </button>
    </span>
  );
}
