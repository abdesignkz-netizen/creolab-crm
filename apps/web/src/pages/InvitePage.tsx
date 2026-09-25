import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, setTenant } from "../lib/api";
import { PasswordInput } from "../components/PasswordInput";

export function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.invitationPreview(token)
      .then((data) => {
        if (!cancelled) setPreview(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Ссылка недействительна");
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) {
    return (
      <div className="login">
        <div className="login-stage">
          <form className="panel">
            <h2>Приглашение</h2>
            <p className="error">{error}</p>
            <Link className="btn secondary" to="/login">Войти</Link>
          </form>
        </div>
      </div>
    );
  }
  if (!preview) return <div className="state">Загрузка…</div>;

  return (
    <div className="login">
      <div className="login-stage">
        <form
          className="panel"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            setBusy(true);
            setError("");
            try {
              const result = (await api.acceptInvitation(token, {
                password: String(form.get("password") || ""),
                name: String(form.get("name") || ""),
              })) as any;
              if (result.tenantId) setTenant(result.tenantId);
              window.location.assign("/today");
            } catch (err: any) {
              if (err?.status === 409 && String(err?.body?.code || "") === "login_required") {
                navigate("/login");
                return;
              }
              setError(err instanceof Error ? err.message : "Не удалось принять приглашение");
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>Приглашение в {preview.tenantName}</h2>
          <p className="muted">
            {preview.email} · {preview.role}
            {preview.existingUser ? " · аккаунт уже есть — войдите тем же email" : ""}
          </p>
          {preview.requiresPassword ? (
            <>
              <label>
                Имя
                <input name="name" defaultValue={preview.name || ""} />
              </label>
              <label>
                Пароль
                <PasswordInput name="password" required minLength={8} autoComplete="new-password" />
              </label>
            </>
          ) : (
            <p className="muted">Если вы уже вошли в нужный аккаунт, нажмите «Принять». Иначе сначала войдите.</p>
          )}
          {error ? <p className="error">{error}</p> : null}
          <button className="btn" disabled={busy}>{busy ? "Сохранение…" : "Принять приглашение"}</button>
        </form>
      </div>
    </div>
  );
}
