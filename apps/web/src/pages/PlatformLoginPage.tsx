import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { BrandLogo } from "../components/BrandLogo";
import { PasswordInput } from "../components/PasswordInput";
import { authErrorMessage, t } from "../i18n";
import { AuthLanguagePicker, useAuthLocale } from "../components/AuthLanguagePicker";

export function PlatformLoginPage() {
  const [error, setError] = useState("");
  const [locale, chooseLocale] = useAuthLocale();
  return (
    <div className="login">
      <div className="login-stage">
        <div className="login-brand">
          <BrandLogo variant="login" />
          <p>{t(locale, "login.platformBrand")}</p>
        </div>
        <AuthLanguagePicker locale={locale} onChange={next => { chooseLocale(next); setError(""); }} />
        <form
          className="panel"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            try {
              await api.platformLogin(String(form.get("email")), String(form.get("password")), "web", locale);
              window.location.assign("/admin");
            } catch (err) {
              setError(authErrorMessage(locale, err));
            }
          }}
        >
          <h2>{t(locale, "login.platformTitle")}</h2>
          <p className="muted">{t(locale, "login.platformHint")}</p>
          <label>
            {t(locale, "login.email")}
            <input name="email" type="email" required autoComplete="username" />
          </label>
          <label>
            {t(locale, "login.password")}
            <PasswordInput locale={locale} name="password" required autoComplete="current-password" />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <button className="btn">{t(locale, "login.submit")}</button>
          <p className="muted login-alt">
            <Link to="/forgot-password">{t(locale, "login.forgot")}</Link>
          </p>
          <p className="muted login-alt">
            <Link to="/login">{t(locale, "login.companyLink")}</Link>
          </p>
        </form>
      </div>
    </div>
  );
}
