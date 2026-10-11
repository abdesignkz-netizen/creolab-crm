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

it("keeps channel, content and schedule restrictions separate from contact refusal", () => {
  for (const text of [
    "Не пишите мне на почту, ответьте здесь",
    "Не пишите нам стоимость, сначала расскажите об услуге",
    "Не пишите мне в выходные",
    "Не пишите мне больше двух предложений за раз",
  ]) {
    assert.equal(isClientRefusalText(text), false, text);
    assert.equal(directHandoffReason(text, parseAIAutomationSettings({})), null, text);
  }
  for (const text of ["Не пишите нам в WhatsApp, я сам свяжусь", "Не пишите мне больше!", "Пожалуйста, не пишите нам.", "Не пишите сюда", "Не пишите мне на почту. Больше не связывайтесь со мной."]) {
    assert.equal(isClientRefusalText(text), true, text);
  }
});

it("understands compound requests and Kazakh requests for a staff member", () => {
  for (const text of ["Не хочу обсуждать цену с ботом, позовите менеджера", "Не нужна консультация, нужен сотрудник", "Маған менеджер керек", "Маған қызметкер қажет", "Маған адам керек"]) {
    assert.equal(directHandoffReason(text, parseAIAutomationSettings({})), "CLIENT_REQUESTED_HUMAN", text);
  }
  for (const text of ["Менеджер керек емес, өзіңіз жауап беріңіз", "Маған қызметкер қажет емес", "Менеджердің қажеті жоқ"]) {
    assert.equal(isHumanRequested(text), false, text);
  }
});
