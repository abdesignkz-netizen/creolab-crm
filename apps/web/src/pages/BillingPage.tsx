import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { OnboardingWizard } from "../components/OnboardingWizard";

const STATUS_LABEL: Record<string, string> = {
  none: "Не подключён",
  pending: "Ожидает оплату",
  active: "Активен",
  past_due: "Просрочен",
  canceled: "Отменён",
  expired: "Истёк",
};

export function BillingPage() {
  const { me } = useSession();
  const [data, setData] = useState<any>(me?.billing || null);
  const [plans, setPlans] = useState<any[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .billing()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Не удалось загрузить тариф"));
    api
      .billingPlans()
      .then((res: any) => setPlans(res.items || []))
      .catch(() => undefined);
  }, []);

  if (!data && !error) return <div className="state">Загрузка…</div>;

  const preview = Boolean(data?.previewMode);
  const planName = data?.planName || "Не подключён";

  return (
    <section className="billing-page stack">
      <div className="page-head">
        <div>
          <h2>Тариф и оплата</h2>
          <p className="muted">Регистрация уже создала компанию. Оплата только открывает рабочие возможности.</p>
        </div>
      </div>
      {error ? <p className="error">{error}</p> : null}
      <div className="panel stack">
        <p>
          Текущий статус: <b>{preview ? "Режим просмотра" : "Рабочий кабинет"}</b>
        </p>
        <p>
          Тариф: <b>{preview ? "Не подключён" : planName}</b>
        </p>
        <p className="muted">
          Подписка: {STATUS_LABEL[data?.subscriptionStatus] || data?.subscriptionStatus || "—"}. Компания:{" "}
          {data?.organizationStatus === "active" ? "активна" : data?.organizationStatus}.
        </p>
        {preview ? (
          <p>Онлайн-оплата пока подключается администратором BasQar. Выберите тариф, и мы активируем его для этой же компании — без повторной регистрации.</p>
        ) : (
          <p className="ok">Тариф активен. Можно подключать WhatsApp, AI и рабочие сценарии.</p>
        )}
        {preview ? (
          <p className="muted">Напишите в поддержку BasQar (кнопка помощи в кабинете). Тариф активируют для этой же компании — повторно регистрироваться не нужно.</p>
        ) : null}
      </div>
      <div className="integ-grid">
        {(plans.length ? plans : [{ code: "starter", name: "Стартовый", price: null }]).map((plan) => (
          <div className="panel" key={plan.code || plan.id}>
            <h3>{plan.name}</h3>
            <p className="muted">{plan.price ? `${plan.price} ₸ / мес` : "Стоимость уточнит администратор BasQar"}</p>
            <ul className="muted">
              <li>WhatsApp и диалоги</li>
              <li>AI-менеджер</li>
              <li>Документы и команда</li>
            </ul>
          </div>
        ))}
      </div>
      <OnboardingWizard />
      <p className="muted">
        Вопросы по подключению тарифа можно задать в <Link to="/today">поддержке</Link> — она доступна и в режиме просмотра.
      </p>
    </section>
  );
}
