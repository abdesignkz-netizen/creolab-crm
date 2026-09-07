import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferClientInterest, inquiryInterest } from "./services/contactInterestService.ts";

function message(text: string, day = 1, extra = {}) {
  return { id: `message-${day}`, text, direction: "inbound", senderKind: "client", createdAt: new Date(`2026-09-0${day}T10:00:00Z`), ...extra };
}

describe("Client interest from conversation", () => {
  it("finds an explicit request even before an inquiry exists", () => {
    assert.deepEqual(inferClientInterest([message("Здравствуйте! Нужна презентация для инвесторов.")]), {
      text: "Нужна презентация для инвесторов.", source: "conversation", messageId: "message-1",
    });
  });
  it("keeps earlier interest after greetings and acknowledgements", () => {
    assert.equal(inferClientInterest([message("Спасибо", 3), message("Сколько стоит разработать сайт?", 1), message("Хорошо", 2)])?.text, "Сколько стоит разработать сайт?");
  });
  it("does not turn staff pitches, internal notes or greetings into interest", () => {
    assert.equal(inferClientInterest([
      message("Нужен сайт?", 1, { direction: "outbound", senderKind: "ai" }),
      message("Клиенту нужен сайт", 2, { internal: true }),
      message("Здравствуйте", 3),
    ]), null);
    assert.equal(inferClientInterest([message("У нас уже есть сайт")]), null);
  });
  it("respects rejection and uses the latest explicit need", () => {
    assert.equal(inferClientInterest([message("Нужен сайт"), message("Сайт больше не нужен", 2)]), null);
    assert.equal(inferClientInterest([message("Нужен сайт"), message("Теперь нужна презентация", 2)])?.text, "Теперь нужна презентация");
    assert.equal(inferClientInterest([message("Нужен сайт"), message("Больше ничего не нужно", 2)]), null);
    assert.equal(inferClientInterest([message("Сайт не нужен, хочу логотип")])?.text, "хочу логотип");
  });
  it("understands a short service answer and a Kazakh request", () => {
    assert.equal(inferClientInterest([message("Презентация")])?.text, "Презентация");
    assert.equal(inferClientInterest([message("Бізге сайт керек")])?.text, "Бізге сайт керек");
  });
  it("keeps inquiry data authoritative and treats whitespace as missing", () => {
    assert.equal(inquiryInterest({ subject: "   ", service: "Брендинг" })?.text, "Брендинг");
    assert.equal(inquiryInterest({ subject: "Ручное описание", service: "Сайт" })?.source, "inquiry");
    assert.equal(inquiryInterest({ subject: " " }), null);
  });
});
