import { useLocale } from "../lib/session";

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
  const text = (ru: string, kk: string, en: string) => locale === "kk" ? kk : locale === "en" ? en : ru;
  const { aiEnabled, aiAvailable, aiUnavailableReason: reason } = connection;
  const awaitingSetup = !aiAvailable && ["ai_not_configured", "ai_disabled", "ai_model_missing"].includes(reason || "");
  const canEnable = connection.status === "CONNECTED" && (aiAvailable || awaitingSetup);
  const status = !aiEnabled ? text("Выключены", "Өшірілген", "Disabled")
    : aiAvailable ? text("Включены", "Қосылған", "Enabled")
    : awaitingSetup ? text("Ожидают настройки администратором", "Әкімшінің баптауын күтуде", "Awaiting administrator setup")
    : text("Недоступны", "Қолжетімсіз", "Unavailable");
  const explanation = reason === "feature_required"
    ? text("ИИ-менеджер не входит в тариф", "ЖИ-менеджер тарифке кірмейді", "AI Manager is not included in the plan")
    : reason === "tenant_inactive"
      ? text("Доступ компании приостановлен.", "Компанияның жүйеге кіруі уақытша тоқтатылған.", "Company access is suspended.")
      : reason === "ai_model_missing"
        ? text("Промпт сохранён. Администратору осталось настроить подключение к модели ИИ.", "ЖИ нұсқаулығы сақталған. Әкімшіге ЖИ моделіне қосылымды баптау қажет.", "Your prompt is saved. The administrator needs to configure the AI model connection.")
        : reason === "ai_disabled"
          ? text("Настройки компании сохранены. Администратору нужно разрешить работу ИИ.", "Компания баптаулары сақталған. Әкімші ЖИ жұмысына рұқсат беруі керек.", "Company settings are saved. The administrator needs to enable AI access.")
          : text("Администратору нужно подготовить и опубликовать промпт компании.", "Әкімші компанияның ЖИ нұсқаулығын дайындап, жариялауы керек.", "The administrator needs to prepare and publish your company's prompt.");

  return <>
    <p>{text("ИИ-ответы", "ЖИ жауаптары", "AI replies")}: <strong>{status}</strong></p>
    {!aiAvailable && <p className="muted">{explanation}</p>}
    <p className="muted">{text(
      "ИИ использует промпт и базу знаний, опубликованные для вашей компании в админ-панели. Новые диалоги обрабатываются автоматически в режиме AUTO с учётом расписания и AI-кредитов. Для существующего диалога нажмите «Вернуть AI». Передача сотруднику останавливает ИИ-ответы.",
      "ЖИ әкімші панелінде компанияңыз үшін жарияланған нұсқаулық пен білім қорын пайдаланады. AUTO режимінде жаңа диалогтар жұмыс кестесі мен ЖИ кредиттері ескеріліп, автоматты түрде өңделеді. Бұрын басталған диалогта «ЖИ-ге қайтару» түймесін басыңыз. Диалог қызметкерге берілгенде ЖИ жауап беруді тоқтатады.",
      "AI uses the prompt and knowledge base published for your company in the admin panel. AUTO mode handles new conversations using your schedule and AI credits. For existing conversations, select Return to AI. Handing a conversation to a staff member stops AI replies.",
    )}</p>
    {(aiEnabled || awaitingSetup) && <div className="banner" role="status">
      {aiEnabled && awaitingSetup && <p>{text(
        "Ваш выбор сохранён. ИИ начнёт отвечать в новых диалогах после завершения настройки администратором.",
        "Таңдауыңыз сақталды. Әкімші баптауды аяқтағаннан кейін ЖИ жаңа диалогтарда жауап бере бастайды.",
        "Your choice is saved. AI will start replying in new conversations once the administrator completes setup.",
      )}</p>}
      <p>{text(
        "Базу знаний и промпт настраивает администратор сервиса. Для настройки и уточнений напишите в WhatsApp:",
        "Білім қоры мен ЖИ нұсқаулығын сервис әкімшісі баптайды. Баптау және сұрақтарды нақтылау үшін WhatsApp арқылы жазыңыз:",
        "The service administrator configures your knowledge base and prompt. For setup and questions, contact us on WhatsApp:",
      )} {" "}<a href="https://wa.me/77067301301" target="_blank" rel="noopener noreferrer">+7 706 730 13 01</a></p>
    </div>}
    <button type="button" className="btn secondary" disabled={busy || (!aiEnabled && !canEnable)} onClick={onToggle}>
      {aiEnabled ? text("Выключить ИИ-ответы", "ЖИ жауаптарын өшіру", "Disable AI replies") : text("Включить ИИ-ответы", "ЖИ жауаптарын қосу", "Enable AI replies")}
    </button>
  </>;
}
