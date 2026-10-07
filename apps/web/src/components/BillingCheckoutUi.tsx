import type { ReactNode } from "react";
import { useLocale } from "../lib/session";
import { api } from "../lib/api";
import "../billing.css";
export function useBillingText() {
  const locale = useLocale();
  return (ru: string, kk: string, en: string) =>
    locale === "kk" ? kk : locale === "en" ? en : ru;
}
const statuses: Record<string, [string, string, string]> = {
  PENDING: ["Ожидает оплаты", "Төлем күтілуде", "Awaiting payment"],
  PENDING_PAYMENT: ["Ожидает оплаты", "Төлем күтілуде", "Awaiting payment"],
  PROCESSING: ["Проверяем оплату", "Төлем тексерілуде", "Verifying payment"],
  PAID: ["Оплачено", "Төленді", "Paid"],
  CONFIRMED: ["Подтверждено", "Расталды", "Confirmed"],
  FAILED: ["Ошибка оплаты", "Төлем орындалмады", "Payment failed"],
  CANCELLED: ["Отменено", "Бас тартылды", "Cancelled"],
  EXPIRED: ["Срок истёк", "Мерзімі аяқталды", "Expired"],
  REFUNDED: ["Возвращено", "Қайтарылды", "Refunded"],
  PARTIALLY_REFUNDED: [
    "Частичный возврат",
    "Ішінара қайтарылды",
    "Partially refunded",
  ],
  active: ["Активна", "Белсенді", "Active"],
  pending: ["Ожидает оплаты", "Төлем күтілуде", "Awaiting payment"],
  past_due: ["Требуется оплата", "Төлем қажет", "Payment due"],
  grace_period: ["Льготный период", "Жеңілдік кезеңі", "Grace period"],
  suspended: ["Приостановлена", "Уақытша тоқтатылды", "Suspended"],
  expired: ["Истекла", "Мерзімі аяқталды", "Expired"],
  trial: ["Пробный период", "Сынақ кезеңі", "Trial"],
  ISSUED: ["Счёт выставлен", "Шот берілді", "Invoice issued"],
  canceled: ["Отменена", "Бас тартылды", "Cancelled"],
};
export function BillingStatus({ status }: { status: string }) {
  const t = useBillingText();
  const text = statuses[status];
  return (
    <span
      className={`billing-status ${["PAID", "CONFIRMED", "active"].includes(status) ? "good" : ["FAILED", "suspended", "past_due"].includes(status) ? "bad" : ""}`}
    >
      {text ? t(...text) : status}
    </span>
  );
}
export function billingMoney(n: number) {
  return (
    new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(n) +
    " ₸"
  );
}
export function billingDate(s?: string | null) {
  return s
    ? new Date(s).toLocaleDateString("ru-RU", { timeZone: "Asia/Almaty" })
    : "—";
}
export async function downloadBillingInvoice(id: string, admin = false) {
  const { blob, filename } = await api.billingInvoice(id, admin);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function BillingField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="billing-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
export const buyerFields = [
  "legalName",
  "bin",
  "legalAddress",
  "email",
  "phone",
] as const;
export function BuyerForm({
  buyer,
  setBuyer,
}: {
  buyer: Record<string, string>;
  setBuyer: (v: Record<string, string>) => void;
}) {
  const t = useBillingText();
  const labels = {
    legalName: t("Название компании", "Компания атауы", "Company name"),
    bin: t("БИН / ИИН", "БСН / ЖСН", "Tax ID"),
    legalAddress: t("Юридический адрес", "Заңды мекенжай", "Legal address"),
    email: "Email",
    phone: t("Телефон", "Телефон", "Phone"),
  };
  return (
    <div className="billing-form-grid">
      {buyerFields.map((k) => (
        <BillingField key={k} label={labels[k]}>
          <input
            required
            type={k === "email" ? "email" : "text"}
            inputMode={k === "bin" ? "numeric" : undefined}
            maxLength={k === "bin" ? 12 : 500}
            value={buyer[k] || ""}
            onChange={(e) => setBuyer({ ...buyer, [k]: e.target.value })}
          />
        </BillingField>
      ))}
    </div>
  );
}

export function useBillingError() {
  const t = useBillingText();
  const messages: Record<string, [string, string, string]> = {
    checkout_exists: [
      "У вас уже есть незавершённый заказ. Откройте его, чтобы продолжить оплату или посмотреть условия отмены.",
      "Сізде аяқталмаған тапсырыс бар. Төлемді жалғастыру немесе бас тарту шарттарын көру үшін оны ашыңыз.",
      "You already have an unfinished order. Open it to continue payment or see cancellation options.",
    ],
    payment_reconciliation_required: [
      "Старая попытка не найдена в текущем магазине Freedom Pay. Администратору нужно открыть «Платежи», найти этот заказ и нажать «Разблокировать после сверки». После проверки отсутствия списания заказ можно отменить.",
      "Ескі әрекет қазіргі Freedom Pay дүкенінде табылмады. Әкімші «Төлемдер» бөлімінде осы тапсырысты тауып, «Тексергеннен кейін бұғатты ашу» түймесін басуы керек. Ақша алынбағаны тексерілгеннен кейін тапсырыстан бас тартуға болады.",
      "The old attempt was not found in the current Freedom Pay merchant. An administrator must find the order in Payments and select Release after reconciliation. After verifying no charge occurred, the order can be cancelled.",
    ],
    payment_processing: [
      "Результат оплаты картой ещё не подтверждён. Откройте текущий заказ и проверьте статус. Если проверка зависла, обратитесь в поддержку.",
      "Карта төлемінің нәтижесі әлі расталмады. Ағымдағы тапсырысты ашып, мәртебені тексеріңіз. Тексеру тоқтап қалса, қолдау қызметіне хабарласыңыз.",
      "The card payment outcome is unconfirmed. Open your current order and check its status. If verification is stuck, contact support.",
    ],
    provider_uncertain: [
      "Проверяем, принял ли банк платёж. Обновите статус через минуту.",
      "Банктің төлемді қабылдағанын тексеріп жатырмыз. Бір минуттан кейін мәртебені жаңартыңыз.",
      "Checking whether the bank accepted the payment. Refresh the status in a minute.",
    ],
    provider_declined: [
      "Банк отклонил запрос оплаты. Выберите другой способ или повторите попытку.",
      "Банк төлем сұрауын қабылдамады. Басқа тәсілді таңдаңыз немесе қайталап көріңіз.",
      "The bank declined this request. Choose another method or try again.",
    ],
    order_closed: [
      "Заказ закрыт или истёк. Создайте новый заказ на странице тарифов.",
      "Тапсырыс жабылды немесе мерзімі аяқталды. Тарифтер бетінде жаңа тапсырыс жасаңыз.",
      "This order is closed or expired. Create a new order from plans.",
    ],
    invalid: [
      "Проверьте введённые данные. Для счёта нужны реквизиты компании, БИН/ИИН из 12 цифр, email и телефон.",
      "Енгізілген деректерді тексеріңіз. Шот үшін компания деректемелері, 12 цифрлы БСН/ЖСН, email және телефон қажет.",
      "Check the entered details. Invoices require company details, a 12-digit Tax ID, email and phone.",
    ],
    provider_not_configured: [
      "Этот способ оплаты пока недоступен. Выберите другой.",
      "Бұл төлем тәсілі әзірге қолжетімсіз. Басқасын таңдаңыз.",
      "This method is not available yet. Choose another method.",
    ],
    provider_signature: [
      "Не удалось проверить подлинность ответа Freedom Pay. Статус оплаты сохранён. Администратору нужно сверить платёж в кабинете банка.",
      "Freedom Pay жауабының түпнұсқалығын тексеру мүмкін болмады. Төлем мәртебесі сақталды. Әкімші төлемді банк кабинетінде тексеруі керек.",
      "Freedom Pay's response could not be verified. Payment status is unchanged. An administrator must reconcile it in the bank dashboard.",
    ],
    provider_mismatch: [
      "Ответ банка не соответствует этому заказу. Администратору нужно проверить подключённый магазин Freedom Pay.",
      "Банк жауабы осы тапсырысқа сәйкес келмейді. Әкімші қосылған Freedom Pay дүкенін тексеруі керек.",
      "The bank response does not match this order. An administrator must check the connected Freedom Pay merchant.",
    ],
    provider_credentials: [
      "Не удалось открыть оплату: Freedom Pay не принял настройки магазина. Администратору нужно проверить подключение.",
      "Төлем бетін ашу мүмкін болмады: Freedom Pay дүкен баптауларын қабылдамады. Әкімші қосылымды тексеруі керек.",
      "Unable to open checkout: Freedom Pay rejected the merchant settings. An administrator must check the connection.",
    ],
  };
  return (error: unknown) => {
    const code =
      error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "";
    return messages[code]
      ? t(...messages[code])
      : t(
          "Не удалось выполнить действие. Обновите страницу и проверьте статус перед повторной оплатой.",
          "Әрекетті орындау мүмкін болмады. Қайта төлемес бұрын бетті жаңартып, мәртебені тексеріңіз.",
          "Unable to complete this action. Refresh and check the status before paying again.",
        );
  };
}
