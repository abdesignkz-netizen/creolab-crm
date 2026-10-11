import assert from "node:assert/strict";
import { it } from "node:test";
import { directHandoffReason, handoffAcknowledgement, isHumanRequested, isClientRefusalText } from "./services/aiHandoffPolicy.ts";
import { parseAIAutomationSettings } from "./services/aiAutomationSettings.ts";

it("keeps RU/KK corrections and person references in the AI conversation", () => {
  for (const text of ["Бір адамға бағасы қанша?", "Менеджерге бермеңіз, өзіңіз жауап беріңіз", "Мне не нужно 20 слайдов, достаточно 10", "Можно без менеджера, просто скажите цену?", "Я менеджер по продажам", "У вас есть менеджер?", "Хочу презентацию для менеджеров", "Менеджермен сөйлескім келмейді", "Не хочу менеджера, хочу узнать цену", "Мне не интересна эта услуга, расскажите о другой", "Мне нужна презентация для менеджеров", "Не пишите цену, я пока хочу узнать об услуге", "Не звоните, пишите здесь", "Қате жазбаңыз, өтінемін"]) {
    assert.equal(directHandoffReason(text, parseAIAutomationSettings({})), null, text);
    assert.equal(isClientRefusalText(text), false, text);
  }
});
it("recognizes explicit handoff in Russian and Kazakh but not negated requests", () => {
  for (const text of ["Позовите менеджера, пожалуйста", "Хочу поговорить с человеком", "Переведите на человека", "Менеджермен сөйлескім келеді", "Қызметкерге беріңіз", "Оператормен байланыстыршы", "Менеджер", "Не нужна консультация. Позовите менеджера."]) assert.equal(isHumanRequested(text), true, text);
});
it("distinguishes contact refusal from refusing an offer", () => {
  for (const text of ["Не пишите больше", "Спасибо, не нужно", "стоп", "Маған жазбаңыз", "Маған хабарласпаңыз", "unsubscribe", "[Расшифровка голосового сообщения]: стоп"]) {
    assert.equal(isClientRefusalText(text), true, text);
    assert.equal(directHandoffReason(text, parseAIAutomationSettings({})), "CLIENT_REFUSED");
    assert.equal(handoffAcknowledgement("CLIENT_REFUSED", [{ role: "user", content: text }]), "");
  }
});
it("uses only a fixed customer acknowledgment, in the customer's language", () => {
  assert.match(handoffAcknowledgement("knowledge_missing", [{ role: "user", content: "Бір адамға бағасы қанша?" }]), /нақтылау/);
  assert.match(handoffAcknowledgement("knowledge_missing", [{ role: "user", content: "Какая гарантия?" }]), /уточнить/);
  assert.match(handoffAcknowledgement("human_requested", [{ role: "user", content: "Позовите менеджера" }]), /Передал/);
});
