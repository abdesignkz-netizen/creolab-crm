import { systemText } from "./systemLocale.ts";

/** Used by process screens/services; keep this copy out of the initial app bundle. */
const processKk: Readonly<Record<string, string>> = {
  "Просрочен срок этапа": "Кезеңнің мерзімі өтті",
  "Просрочена связанная задача": "Байланысты тапсырманың мерзімі өтті",
  "Не указан срок следующего шага": "Келесі қадамның мерзімі көрсетілмеген",
  "Предложение осталось без ответа": "Ұсыныс жауапсыз қалды",
  "Превышен срок без контакта с клиентом": "Клиентпен байланыссыз кезеңнің мерзімі асып кетті",
  "Превышен срок без продвижения по сделке": "Мәмілені ілгерілетпей күту мерзімі асып кетті",
  "Задержки считаются по рабочему календарю компании.": "Кешігулер компанияның жұмыс күнтізбесі бойынша есептеледі.",
  "Задержки считаются в календарных днях.": "Кешігулер күнтізбелік күндермен есептеледі.",
};

export function processRuleText(locale: string, text: string): string {
  return locale.toLowerCase().startsWith("kk") && processKk[text] ? processKk[text] : systemText(locale, text);
}
