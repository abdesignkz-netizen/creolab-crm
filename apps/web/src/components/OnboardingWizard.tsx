import { Link } from "react-router-dom";
import { systemText } from "@creolab/contracts";
import { useLocale, useSession } from "../lib/session";
import { useSetup } from "./SetupAssistant";

export function OnboardingWizard() {
  const { state, error } = useSetup(), { caps } = useSession(), locale = useLocale();
  if (!caps.companyAdmin || (!error && (!state?.suggested || state.completed))) return null;
  return <section className="setup-entry panel">
    <div><strong>{systemText(locale, "Начало работы")}</strong><p>{error || systemText(locale, state?.deferred ? "Продолжите настройку, когда будет удобно. Ваш прогресс сохранён." : "Подключите канал, настройте ответы и проверьте первое обращение.")}</p></div>
    <Link to="/start" className="btn">{systemText(locale, "Продолжить настройку")}{state && ` · ${state.steps.filter(s => s.done).length}/${state.steps.length}`}</Link>
  </section>;
}
