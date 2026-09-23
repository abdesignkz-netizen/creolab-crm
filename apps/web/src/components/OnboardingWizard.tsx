import { Link, useLocation } from "react-router-dom";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { notifySaved } from "../components/SaveNotice";
import { normalizeLocale, t } from "../i18n";

const STEPS = [
  { id: "company", title: "Данные компании", text: "Заполните реквизиты, когда будете готовы выставлять документы.", to: "/settings?section=company" },
  { id: "ai", title: "Настройка AI-менеджера", text: "Проверьте промт и базу знаний перед запуском.", to: "/settings/ai-automation" },
  { id: "whatsapp", title: "Подключение WhatsApp", text: "Укажите Instance ID и API Token Green API.", to: "/integrations" },
  { id: "team", title: "Приглашение команды", text: "Добавьте сотрудников, когда появятся первые обращения.", to: "/settings?section=members" },
];

export function OnboardingWizard() {
  const { me } = useSession();
  const location = useLocation();
  const locale = normalizeLocale(me?.user?.locale);
  const billing = me?.billing;
  if (!billing) return null;
  if (billing.previewMode) {
    if (location.pathname.startsWith("/billing")) return null;
    return (
      <div className="panel onboarding-card preview-welcome">
        <h3>{t(locale, "preview.welcomeTitle")}</h3>
        <p className="muted">{t(locale, "preview.welcomeText")}</p>
        <Link className="btn" to="/billing">{t(locale, "preview.choosePlan")}</Link>
      </div>
    );
  }
  if (billing.subscriptionStatus !== "active") return null;
  if (!billing.onboarding?.needed) return null;
  const done = billing.onboarding.steps || {};
  const steps = STEPS.filter(step => step.id === "company" || (step.id === "ai" && billing.entitlements?.AI_MANAGER) || (step.id === "whatsapp" && billing.entitlements?.WHATSAPP) || (step.id === "team" && billing.entitlements?.TEAM));

  async function skip() {
    await api.skipOnboarding();
    notifySaved("Можно настроить позже");
    window.location.reload();
  }

  async function complete(step: string) {
    await api.completeOnboardingStep(step);
    window.location.reload();
  }

  return (
    <div className="panel onboarding-card">
      <h3>Настройте рабочий кабинет</h3>
      <p className="muted">Тариф активен. Пройдите шаги, когда будет удобно — ничего не блокируется.</p>
      <ol className="onboarding-steps">
        {steps.map((step, index) => (
          <li key={step.id} className={done[step.id] ? "is-done" : ""}>
            <div>
              <b>
                Шаг {index + 1}. {step.title}
              </b>
              <p className="muted">{step.text}</p>
            </div>
            <div className="actions">
              {done[step.id] ? (
                <span className="muted">Готово</span>
              ) : (
                <>
                  <Link className="btn" to={step.to} onClick={() => void complete(step.id)}>
                    Настроить
                  </Link>
                  <button className="btn secondary" type="button" onClick={() => void complete(step.id)}>
                    Настроить позже
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
      <button className="btn secondary" type="button" onClick={() => void skip()}>
        Настроить позже
      </button>
    </div>
  );
}
