import { useState, type InputHTMLAttributes } from "react";

import { useLocale } from "../lib/session";
import { t } from "../i18n";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export function PasswordInput({ className = "", ...props }: PasswordInputProps) {
  const locale = useLocale();
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
