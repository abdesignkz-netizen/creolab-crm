import { useState, type InputHTMLAttributes } from "react";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

export function PasswordInput({ className = "", ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <span className="password-field">
      <input {...props} className={className} type={visible ? "text" : "password"} />
      <button
        type="button"
        className="password-toggle"
        aria-label={visible ? "Скрыть пароль" : "Показать пароль"}
        aria-pressed={visible}
        title={visible ? "Скрыть пароль" : "Показать пароль"}
        onClick={() => setVisible(value => !value)}
      >
        {visible ? "Скрыть" : "Показать"}
      </button>
    </span>
  );
}
