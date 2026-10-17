import { Link } from "react-router-dom";
import { useLocale, useSession } from "../lib/session";

type AiConnection = {
  status: string;
  aiEnabled: boolean;
  aiAvailable: boolean;
  aiUnavailableReason: string | null;
};

export function WhatsAppAiControls({ connection, busy, onToggle }: {
  connection: AiConnection;
  busy: boolean;
  onToggle: () => void;
}) {
  const locale = useLocale();
  const { me } = useSession();
  const text = (ru: string, kk: string, en: string) => locale === "kk" ? kk : locale === "en" ? en : ru;
  const { aiEnabled, aiAvailable, aiUnavailableReason: reason } = connection;
  const awaitingSetup = !aiAvailable && ["ai_not_configured", "ai_disabled", "ai_model_missing"].includes(reason || "");
  const canEnable = connection.status === "CONNECTED" && (aiAvailable || awaitingSetup);
  const status = !aiEnabled ? text("Выключены", "Өшірілген", "Disabled")
    : aiAvailable ? text("Включены", "Қосылған", "Enabled")
    : awaitingSetup ? text("Ожидают настройки", "Баптауды күтуде", "Awaiting setup")
    : text("Недоступны", "Қолжетімсіз", "Unavailable");
  const explanation = reason === "feature_required"
    ? text("ИИ-менеджер не входит в тариф", "ЖИ-менеджер тарифке кірмейді", "AI Manager is not included in the plan")
    : reason === "tenant_inactive"
      ? text("Доступ компании приостановлен.", "Компанияның жүйеге кіруі уақытша тоқтатылған.", "Company access is suspended.")
      : reason === "ai_model_missing"
        ? text("Промпт сохранён. Администратору осталось настроить подключение к модели ИИ.", "ЖИ нұсқаулығы сақталған. Әкімшіге ЖИ моделіне қосылымды баптау қажет.", "Your prompt is saved. The administrator needs to configure the AI model connection.")
        : reason === "ai_disabled"
          ? text("Настройки компании сохранены. Администратору нужно разрешить работу ИИ.", "Компания баптаулары сақталған. Әкімші ЖИ жұмысына рұқсат беруі керек.", "Company settings are saved. The administrator needs to enable AI access.")
          : text("Владельцу компании нужно заполнить и опубликовать настройки ИИ-менеджера.", "Компания иесі ЖИ-менеджер баптауларын толтырып, жариялауы керек.", "The company owner needs to complete and publish the AI Manager settings.");

  return <>
    <p>{text("ИИ-ответы", "ЖИ жауаптары", "AI replies")}: <strong>{status}</strong></p>
    {!aiAvailable && <p className="muted">{explanation}</p>}
    <p className="muted">{text(
      "ИИ использует опубликованные инструкции и базу знаний компании. Кому и когда отвечать, определяют общие правила ИИ-менеджера. Диалоги, переданные сотруднику, остаются у сотрудника до нажатия «Вернуть AI».",
      "ЖИ компанияның жарияланған нұсқаулықтары мен білім қорын пайдаланады. Кімге және қашан жауап беру керегін ЖИ-менеджердің жалпы ережелері анықтайды. Қызметкерге берілген диалогтар «ЖИ-ге қайтару» басылғанша қызметкерде қалады.",
      "AI uses your company's published instructions and knowledge base. The AI Manager rules determine who gets replies and when. Conversations handed to staff stay with staff until Return to AI is selected.",
    )}</p>
    {aiEnabled && awaitingSetup && <div className="banner" role="status">
      <p>{text(
        "Ваш выбор сохранён. Ответы станут доступны после завершения настройки с учётом выбранной аудитории и расписания.",
        "Таңдауыңыз сақталды. Баптау аяқталған соң жауаптар таңдалған аудитория мен кестеге сәйкес қолжетімді болады.",
        "Your choice is saved. Replies will become available after setup, following your audience and schedule settings.",
      )}</p>
    </div>}
    {me?.capabilities?.aiSettings && <div className="actions">
      <Link to="/settings/ai-manager">{text("Знания и цель ИИ", "ЖИ білімі мен мақсаты", "AI knowledge and goal")}</Link>
      <Link to="/settings/ai-automation">{text("Кому и когда отвечать", "Кімге және қашан жауап беру керек", "Who to reply to and when")}</Link>
    </div>}
    <button type="button" className="btn secondary" disabled={busy || (!aiEnabled && !canEnable)} onClick={onToggle}>
      {aiEnabled ? text("Выключить ИИ-ответы", "ЖИ жауаптарын өшіру", "Disable AI replies") : text("Включить ИИ-ответы", "ЖИ жауаптарын қосу", "Enable AI replies")}
    </button>
  </>;
}
