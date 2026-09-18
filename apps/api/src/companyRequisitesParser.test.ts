import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRequisitesBlock, recognizeCompanyRequisites } from "./services/companyRequisitesParser.ts";

const paste = `ТОО "ARASAKA"
БИН/ИИН: 150540023591
Юридический адрес: РК, г. Алматы, ул. Абиш Кекилбайулы 131, кв 5.
ИИК: KZ 12 3456 7890 1234 5678
Банк: АО "Банк ЦентрКредит"
БИК: KCJBKZKX
Директор: Миндыкулов К. А.
Тел.: +7 776 002 02 09
E-mail: office@arasaka.kz`;

const invoice = `Счёт на оплату № 26-0121 от 03.09.2026 г.
Бенефициар
ТОО «Creolab»
БИН: 221140036408
ИИК KZ268562203127261373
Банк бенефициара
АО "Банк ЦентрКредит"
БИК KCJBKZKX
Поставщик: БИН/ИИН 221140036408, ТОО «Creolab», РК, 050026, г. Алматы, ул. Монгольская 44
Тел.: +7 (707) 747 13 01
Покупатель: БИН/ИИН 150540023591, ТОО "ARASAKA", РК, г.Алматы, ул. Абиш Кекилбайулы 131, кв 5.
Тел: +7 776 002 02 09
Договор: № 03092026/01 от 03.09.2026
`;

describe("company requisites parser", () => {
  it("reads a pasted requisites block", () => {
    const draft = parseRequisitesBlock(paste);
    assert.equal(draft.name, 'ТОО "ARASAKA"');
    assert.equal(draft.bin, "150540023591");
    assert.match(draft.legalAddress, /Абиш Кекилбайулы/);
    assert.equal(draft.city, "Алматы");
    assert.equal(draft.iban, "KZ123456789012345678");
    assert.match(draft.bankName, /Банк ЦентрКредит/);
    assert.equal(draft.bik, "KCJBKZKX");
    assert.match(draft.directorName, /Миндыкулов/);
    assert.match(draft.phone, /776 002 02 09/);
    assert.equal(draft.email, "office@arasaka.kz");
    const recognized = recognizeCompanyRequisites(paste);
    assert.equal(recognized.draft.bik, "KCJBKZKX");
    assert.match(recognized.draft.bankName, /Банк ЦентрКредит/);
  });

  it("prefers the buyer on an invoice and does not take the seller bank", () => {
    const { draft, source } = recognizeCompanyRequisites(invoice, { tenantBin: "221140036408" });
    assert.equal(source, "buyer");
    assert.equal(draft.name, 'ТОО "ARASAKA"');
    assert.equal(draft.bin, "150540023591");
    assert.equal(draft.iban, "");
    assert.equal(draft.bankName, "");
    assert.match(draft.legalAddress, /Кекилбайулы/);
    assert.match(draft.phone, /776 002 02 09/);
  });

  it("читает БИН/ИИН с пробелами, как в печатной форме 1С", () => {
    const { draft, source } = recognizeCompanyRequisites(
      `Покупатель: БИН/ИИН 150 540 023 591, ТОО "ARASAKA", РК, г.Алматы
Поставщик: БИН/ИИН 221 140 036 408, ТОО «Creolab», РК, г. Алматы`,
      { tenantBin: "221140036408" },
    );
    assert.equal(source, "buyer");
    assert.equal(draft.bin, "150540023591");
    assert.match(draft.name, /ARASAKA/);
  });

  it("warns when the only organisation is the current tenant", () => {
    const { warnings, draft } = recognizeCompanyRequisites(
      `ТОО «Creolab»\nБИН 221140036408\nИИК KZ268562203127261373`,
      { tenantBin: "221140036408" },
    );
    assert.equal(draft.bin, "221140036408");
    assert.ok(warnings.some((warning) => /вашей организации/i.test(warning)));
  });
});
