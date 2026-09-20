import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { notifySaved } from "../components/SaveNotice";

const STEPS = [
  { id: "company", title: "Данные компании", text: "Заполните реквизиты, когда будете готовы выставлять документы.", to: "/settings?section=company" },
  { id: "ai", title: "Настройка AI-менеджера", text: "Проверьте промт и базу знаний перед запуском.", to: "/settings/ai-automation" },
  { id: "whatsapp", title: "Подключение WhatsApp", text: "Укажите Instance ID и API Token Green API.", to: "/integrations" },
  { id: "team", title: "Приглашение команды", text: "Добавьте сотрудников, когда появятся первые обращения.", to: "/settings?section=members" },
];

export function OnboardingWizard() {
  const { me } = useSession();
  const billing = me?.billing;
  if (!billing || billing.previewMode || billing.subscriptionStatus !== "active") return null;
  if (!billing.onboarding?.needed) return null;
  const done = billing.onboarding.steps || {};

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
        {STEPS.map((step, index) => (
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
