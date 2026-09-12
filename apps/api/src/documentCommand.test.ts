import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectDocumentCommand } from "./services/documentCommandService.ts";

describe("Document command detector", () => {
  it("отличает юридические команды от WhatsApp «отправь договор» и КП", () => {
    assert.equal(detectDocumentCommand("Сформируй договор по сделке Сайт")?.action, "generate_contract");
    assert.equal(detectDocumentCommand("Подготовь черновик договора")?.action, "generate_contract");
    assert.equal(detectDocumentCommand("Подготовь черновик договора")?.prepareOnly, true);
    assert.equal(detectDocumentCommand("Выставь счёт")?.action, "generate_invoice");
    assert.equal(detectDocumentCommand("Создай АВР")?.action, "create_avr");
    assert.equal(detectDocumentCommand("Проверь АВР")?.action, "validate_avr");
    assert.equal(detectDocumentCommand("Отправь АВР в ИС ЭСФ")?.action, "send_avr");
    assert.equal(detectDocumentCommand("Отправь ЭСФ")?.action, "send_esf");
    assert.equal(detectDocumentCommand("Отправь договор на подпись")?.action, "send_for_sign");
    assert.equal(detectDocumentCommand("Закрой сделку")?.action, "close_deal");
    assert.equal(detectDocumentCommand("Отправь договор Ивану"), null);
    assert.equal(detectDocumentCommand("Отправь КП вчерашним клиентам"), null);
    assert.equal(detectDocumentCommand("скажи что файл готов"), null);
  });
});
