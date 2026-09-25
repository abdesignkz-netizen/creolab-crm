import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { BrandLogo } from "../components/BrandLogo";
import { PasswordInput } from "../components/PasswordInput";
import { normalizeLocale, t } from "../i18n";

type Step = "email" | "code" | "password" | "done";

function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!local || !domain) return email;
  return `${local.slice(0, 1)}***@${domain}`;
}

function publicError(err: unknown, fallback: string) {
  const error = err as { message?: string; code?: string; status?: number };
  if (error?.message === "Failed to fetch" || error?.message === "HTTP 500") {
    return "Сейчас не удаётся выполнить запрос. Попробуйте ещё раз через минуту.";
  }
  if (error?.code === "rate_limited") return "Слишком много запросов. Подождите минуту.";
  if (error?.code === "expired_code") return t(normalizeLocale(null), "login.resetExpired");
  if (error?.code === "too_many_attempts") return t(normalizeLocale(null), "login.resetTooMany");
  if (error?.code === "invalid_code") return t(normalizeLocale(null), "login.resetInvalidCode");
  if (error?.code === "invalid_token") return t(normalizeLocale(null), "login.resetInvalidToken");
  if (typeof error?.message === "string" && error.message && !/^HTTP \d+/.test(error.message)) return error.message;
  return fallback;
}

function ResetCodeInputs({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([]);

  function setDigit(index: number, digit: string) {
    const next = value.slice();
    next[index] = digit;
    onChange(next);
    if (digit && index < 5) refs.current[index + 1]?.focus();
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (text.length < 2) return;
    event.preventDefault();
    const next = Array.from({ length: 6 }, (_, i) => text[i] || "");
    onChange(next);
    refs.current[Math.min(text.length, 5)]?.focus();
  }

  function onKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Backspace" && !value[index] && index > 0) {
      event.preventDefault();
      const next = value.slice();
      next[index - 1] = "";
      onChange(next);
      refs.current[index - 1]?.focus();
    }
  }

  return (
    <div className="login-otp" role="group" aria-label="Код">
      {value.map((digit, index) => (
        <input
          key={index}
          ref={(node) => {
            refs.current[index] = node;
          }}
          inputMode="numeric"
          autoComplete={index === 0 ? "one-time-code" : "off"}
          maxLength={1}
          value={digit}
          disabled={disabled}
          onPaste={onPaste}
          onKeyDown={(event) => onKeyDown(index, event)}
          onChange={(event) => setDigit(index, event.target.value.replace(/\D/g, "").slice(-1))}
        />
      ))}
    </div>
  );
}

export function ForgotPasswordPage() {
  const locale = normalizeLocale(null);
  const [searchParams] = useSearchParams();
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState(searchParams.get("email") || "");
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [resetToken, setResetToken] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  function startCooldown() {
    setCooldown(60);
  }

  async function submitEmail(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.requestPasswordReset(email);
      setDigits(["", "", "", "", "", ""]);
      setResetToken("");
      setStep("code");
      startCooldown();
    } catch (err) {
      setError(publicError(err, "Не удалось отправить запрос"));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    const code = digits.join("");
    if (!/^\d{6}$/.test(code)) {
      setError(t(locale, "login.resetInvalidCode"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = (await api.verifyPasswordReset(email, code)) as { resetToken?: string };
      if (!result.resetToken) {
        setError(t(locale, "login.resetInvalidCode"));
        return;
      }
      setResetToken(result.resetToken);
      setStep("password");
    } catch (err) {
      setError(publicError(err, t(locale, "login.resetInvalidCode")));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (cooldown > 0 || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.resendPasswordReset(email);
      setDigits(["", "", "", "", "", ""]);
      startCooldown();
    } catch (err) {
      setError(publicError(err, "Не удалось отправить код"));
    } finally {
      setBusy(false);
    }
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (password !== passwordConfirm) {
      setError("Пароли не совпадают");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.completePasswordReset(resetToken, password, passwordConfirm);
      setResetToken("");
      setPassword("");
      setPasswordConfirm("");
      setStep("done");
    } catch (err) {
      setError(publicError(err, "Не удалось сохранить пароль"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login-stage">
        <div className="login-brand">
          <BrandLogo variant="login" />
          <p>{t(locale, "login.brand")}</p>
        </div>
        {step === "email" ? (
          <form className="panel" onSubmit={submitEmail}>
            <h2>{t(locale, "login.resetTitle")}</h2>
            <p className="muted">{t(locale, "login.resetHint")}</p>
            <label>
              {t(locale, "login.email")}
              <input
                name="email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            {error ? <p className="error">{error}</p> : null}
            <button className="btn" disabled={busy}>{t(locale, "login.resetContinue")}</button>
            <p className="muted login-alt">
              <Link to="/login">{t(locale, "login.backToLogin")}</Link>
            </p>
          </form>
        ) : null}
        {step === "code" ? (
          <form className="panel" onSubmit={submitCode}>
            <h2>{t(locale, "login.resetCheckTitle")}</h2>
            <p className="muted">{t(locale, "login.resetCheckHint")}</p>
            <p className="muted">{maskEmail(email)}</p>
            <ResetCodeInputs value={digits} onChange={setDigits} disabled={busy} />
            {error ? <p className="error">{error}</p> : null}
            <button className="btn" disabled={busy || digits.join("").length !== 6}>
              {t(locale, "login.resetConfirm")}
            </button>
            <button
              type="button"
              className="btn secondary"
              disabled={busy || cooldown > 0}
              onClick={() => void resend()}
            >
              {cooldown > 0
                ? t(locale, "login.resetResendIn").replace("{n}", String(cooldown))
                : t(locale, "login.resetResend")}
            </button>
            <p className="muted login-alt">
              <button
                type="button"
                className="linkish"
                onClick={() => {
                  setStep("email");
                  setError("");
                  setDigits(["", "", "", "", "", ""]);
                  setResetToken("");
                }}
              >
                {t(locale, "login.resetChangeEmail")}
              </button>
            </p>
          </form>
        ) : null}
        {step === "password" ? (
          <form className="panel" onSubmit={submitPassword}>
            <h2>{t(locale, "login.resetNewTitle")}</h2>
            <label>
              {t(locale, "login.resetNewPassword")}
              <PasswordInput
                required
                minLength={10}
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label>
              {t(locale, "login.resetRepeatPassword")}
              <PasswordInput
                required
                minLength={10}
                autoComplete="new-password"
                value={passwordConfirm}
                onChange={(event) => setPasswordConfirm(event.target.value)}
              />
            </label>
            {error ? <p className="error">{error}</p> : null}
            <button className="btn" disabled={busy}>{t(locale, "login.resetSave")}</button>
          </form>
        ) : null}
        {step === "done" ? (
          <div className="panel login-reset-done">
            <h2>{t(locale, "login.resetDoneTitle")}</h2>
            <p className="muted">{t(locale, "login.resetDoneHint")}</p>
            <Link className="btn" to="/login">{t(locale, "login.submit")}</Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}
