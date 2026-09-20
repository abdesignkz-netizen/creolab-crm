import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import JSZip from "jszip";
import { createPrismaClient } from "@creolab/db";
import { createApp } from "./app.ts";
import { scanContractTemplateText, rewriteScannedFragment } from "./services/contractTemplateScan.ts";
import { extractDocUnicodeText, docxToText } from "./services/wordDocumentText.ts";
import { fillDocxPlaceholders, rewriteDocxText } from "./services/docxTemplateFill.ts";

const SAMPLE = `Договор №05082026/01
об оказании возмездных услуг

г. Алматы                                                                                                        «5» августа 2026 г.

ТОО «Creolab», именуемое в дальнейшем «Исполнитель», в лице Директора Иванов Иван, действующего на основании Устава, с одной стороны, и ТОО «АрыстанТехСервис», именуемое в дальнейшем «Заказчик», в лице Директора Шайдуллинов Р. К., действующего на основании Устава, с другой стороны, далее совместно именуемые «Стороны», заключили настоящий Договор о нижеследующем.

ПРЕДМЕТ ДОГОВОРА
2.1. По настоящему договору Исполнитель обязуется оказать Услуги, а Заказчик обязуется принять и оплатить эти услуги.
2.2.1. Разработать презентацию компании.

ПОРЯДОК ОПЛАТЫ
4.5.1. Не позднее 3 рабочих дней Заказчик производит предоплату в размере 50% от Стоимости оказания Услуг, которая составляет 60 000 (Шестьдесят тысяч) тенге.
4.5.2. Не позднее 3 рабочих дней Заказчик обязан оплатить оставшиеся 50% от Стоимости оказанных Услуг, которая составляет 60 000 (Шестьдесят тысяч) тенге.

Приложение №2
Итого: 120 000

11. РЕКВИЗИТЫ СТОРОН

ТОО «АрыстанТехСервис»
РК, город Астана, район Есиль, улица Сыганак, д.4
БИН 222222222220
KZ5396503F0007969139
АО «ForteBank»
БИК: IRTYKZKA

ТОО «Creolab»
РК, г. Алматы, пр. Абая 1
БИН 123456789013
АО «Банк ЦентрКредит»
KZ111111111111111111
БИК: KCJBKZKX`;

async function makeDocx(text: string) {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  const body = text
    .split("\n")
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${line.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`)
    .join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
}

describe("Contract Word templates", () => {
  let prisma: Awaited<ReturnType<typeof createPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let server: { close: () => void };
  let base = "";
  let cookie = "";
  let otherCookie = "";

  async function json(path: string, init: RequestInit = {}, useCookie = cookie) {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        cookie: useCookie,
        ...(init.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  }

  it("заменяет стороны примера презентации на поля шаблона", () => {
    const scanned = scanContractTemplateText(SAMPLE, {
      legalName: "ТОО CREOLAB",
      bin: "123456789013",
      legalAddress: "г. Алматы, пр. Абая 1",
      directorName: "Иванов Иван",
    }, "Договор на возмездные услуги.doc");
    assert.match(scanned.body, /\{\{seller_name\}\}/);
    assert.match(scanned.body, /\{\{buyer_name\}\}/);
    assert.match(scanned.body, /\{\{seller_bin\}\}/);
    assert.match(scanned.body, /\{\{buyer_bin\}\}/);
    assert.match(scanned.body, /\{\{contract_number\}\}/);
    assert.match(scanned.body, /\{\{contract_date\}\}/);
    assert.match(scanned.body, /\{\{prepayment_amount\}\}/);
    assert.match(scanned.body, /\{\{remainder_amount\}\}/);
    assert.match(scanned.body, /\{\{items_table\}\}/);
    assert.match(scanned.body, /Разработать презентацию компании/);
    assert.doesNotMatch(scanned.body, /АрыстанТехСервис/);
    assert.equal(scanned.buyer.bin, "222222222220");
    assert.equal(scanned.seller.bin, "123456789013");
    assert.match(scanned.name, /возмездн|презентац/i);
    assert.equal(scanned.fields.find((field) => field.key === "contract_number")?.found, true);
    assert.equal(scanned.fields.find((field) => field.key === "prepayment_amount")?.found, true);
    assert.match(scanned.fields.find((field) => field.key === "contract_number")?.sample || "", /05082026/);
  });

  it("находит заказчика в преамбуле даже без запятой перед «именуемое»", () => {
    const text = `ДОГОВОР №05082026/01
ТОО «Creolab», именуемое в дальнейшем «Исполнитель», в лице Директора Булан А. Б., действующего на основании Устава, с одной стороны, и ТОО «Minerals Supply Services Atyrau» именуемое в дальнейшем «Заказчик», в лице Директора Мухсинов Е. Н., действующего на основании Устава, с другой стороны, заключили настоящий Договор о нижеследующем.

ТЕРМИНЫ И ОПРЕДЕЛЕНИЯ, ИСПОЛЬЗУЕМЫЕ В ДОГОВОРЕ
Услуги – дизайнерские услуги в полном объеме в соответствии с Техническим заданием (Приложение № 1 к Договору).

11. РЕКВИЗИТЫ СТОРОН
ТОО «Minerals Supply Services Atyrau»
РК, г. Атырау
БИН 140540016755
KZ5396503F0007969139
АО «ForteBank»
БИК: IRTYKZKA

ТОО «Creolab»
РК, г. Алматы, ул. Монгольская, 44
БИН 221140036408
KZ111111111111111111
АО «Банк ЦентрКредит»
БИК: KCJBKZKX`;
    const scanned = scanContractTemplateText(text, {
      legalName: "ТОО «Creolab»",
      bin: "221140036408",
      directorName: "Булан А. Б.",
    });
    assert.match(scanned.buyer.name, /Minerals Supply Services Atyrau/i);
    assert.equal(scanned.buyer.bin, "140540016755");
    assert.equal(scanned.buyer.directorName, "Мухсинов Е. Н.");
    assert.match(scanned.body, /\{\{buyer_name\}\}/);
    assert.match(scanned.body, /\{\{seller_name\}\}/);
    assert.match(scanned.body, /ТЕРМИНЫ И ОПРЕДЕЛЕНИЯ/);
    assert.match(scanned.body, /Приложение № 1/);
    assert.equal(scanned.warnings.length, 0);
  });

  it("понимает преамбулу, где «в лице» стоит до «именуемое»", () => {
    const text = `ДОГОВОР оказания услуг №05082026/01

г. Алматы                                          «19» сентября 2026 года

ТОО «Creolab», в лице Директора Булан А. Б., действующего на основании Устава, именуемое в дальнейшем «Исполнитель», с одной стороны, и ТОО «Minerals Supply Services Atyrau», в лице Директора Мухсинов Е. Н., действующего на основании Устава, именуемое в дальнейшем «Заказчик», с другой стороны, заключили настоящий Договор о нижеследующем.

ПРЕДМЕТ ДОГОВОРА
2.1. Исполнитель обязуется оказать услуги.

11. РЕКВИЗИТЫ СТОРОН
ТОО «Minerals Supply Services Atyrau»
РК, г. Атырау
БИН 140540016755
ИИК KZ5396503F0007969139
АО «ForteBank»
БИК: IRTYKZKA

ТОО «Creolab»
РК, г. Алматы, ул. Монгольская, 44
БИН 221140036408
KZ111111111111111111
АО «Банк ЦентрКредит»
БИК: KCJBKZKX`;
    const scanned = scanContractTemplateText(text, {
      legalName: "ТОО «Creolab»",
      bin: "221140036408",
      directorName: "Булан А. Б.",
    });
    assert.match(scanned.seller.name, /Creolab/i);
    assert.match(scanned.buyer.name, /Minerals Supply Services Atyrau/i);
    assert.equal(scanned.seller.bin, "221140036408");
    assert.equal(scanned.buyer.bin, "140540016755");
    assert.equal(scanned.seller.directorName, "Булан А. Б.");
    assert.equal(scanned.buyer.directorName, "Мухсинов Е. Н.");
    assert.match(scanned.body, /\{\{seller_name\}\}/);
    assert.match(scanned.body, /\{\{buyer_name\}\}/);
    assert.match(scanned.body, /\{\{contract_number\}\}/);
    assert.match(scanned.body, /\{\{contract_date\}\}/);
    assert.match(scanned.body, /\{\{items_table\}\}/);
    assert.match(scanned.body, /ПРЕДМЕТ ДОГОВОРА/);
    const itemsAt = scanned.body.indexOf("{{items_table}}");
    const requisitesAt = scanned.body.search(/РЕКВИЗИТЫ\s+СТОРОН/i);
    assert.ok(itemsAt > 0 && itemsAt < requisitesAt);
  });

  it("распознаёт заказчика, если в договоре он назван «Покупатель»", () => {
    const text = `Договор №12
ТОО «Creolab», именуемое далее «Исполнитель», в лице Директора Иванов Иван, и ТОО «АрыстанТехСервис», именуемое далее «Покупатель», в лице Директора Шайдуллинов Р. К., заключили настоящий Договор о нижеследующем.

РЕКВИЗИТЫ СТОРОН
ТОО «АрыстанТехСервис»
БИН 222222222220
ТОО «Creolab»
БИН 123456789013`;
    const scanned = scanContractTemplateText(text, { legalName: "ТОО CREOLAB", bin: "123456789013" });
    assert.match(scanned.buyer.name, /АрыстанТехСервис/);
    assert.match(scanned.body, /\{\{buyer_name\}\}/);
    assert.match(scanned.body, /\{\{seller_name\}\}/);
  });

  it("по контексту отличает переменные в договоре другого вида", () => {
    const text = `ДОГОВОР ПОСТАВКИ № 15/К-26

г. Астана                                                                 03.09.2026

ТОО «Creolab», именуемое в дальнейшем «Поставщик», в лице Директора Иванов Иван, действующего на основании Устава, с одной стороны, и ТОО «АрыстанТехСервис», именуемое в дальнейшем «Покупатель», в лице Директора Шайдуллинов Р. К., действующего на основании Устава, с другой стороны, заключили настоящий Договор о нижеследующем.

1. ПРЕДМЕТ
1.1. Поставщик обязуется передать Товар, а Покупатель принять и оплатить его.

3. СТОИМОСТЬ
3.1. Общая стоимость Товара составляет 450 000 (Четыреста пятьдесят тысяч) тенге.
3.2. Покупатель оплачивает 100% стоимости в течение 10 банковских дней.
3.3. За просрочку оплаты Покупатель уплачивает неустойку в размере 10 000 (Десять тысяч) тенге.

4. СРОКИ
4.1. Срок поставки: 12 рабочих дней.

Приложение № 1 к Договору № 15/К-26 от 03.09.2026

11. РЕКВИЗИТЫ СТОРОН

ТОО «АрыстанТехСервис»
РК, город Астана
БИН 222222222220
KZ5396503F0007969139
АО «ForteBank»
БИК: IRTYKZKA

ТОО «Creolab»
РК, г. Алматы, пр. Абая 1
БИН 123456789013
АО «Банк ЦентрКредит»
KZ111111111111111111
БИК: KCJBKZKX`;
    const scanned = scanContractTemplateText(text, {
      legalName: "ТОО CREOLAB",
      bin: "123456789013",
      directorName: "Иванов Иван",
    }, "Договор поставки.docx");
    assert.equal(scanned.name, "Договор поставки");
    assert.match(scanned.seller.name, /Creolab/i);
    assert.match(scanned.buyer.name, /АрыстанТехСервис/);
    assert.match(scanned.body, /Договор[^\n]*№ \{\{contract_number\}\}/i);
    assert.match(scanned.body, /Приложение № 1 к Договору № \{\{contract_number\}\}/);
    assert.match(scanned.body, /\{\{contract_date\}\}/);
    assert.match(scanned.body, /\{\{amount\}\}/);
    assert.match(scanned.body, /10 банковских дней/);
    assert.match(scanned.body, /неустойку в размере 10 000/);
    assert.doesNotMatch(scanned.body, /15\/К-26/);
    assert.doesNotMatch(scanned.body, /450 000/);
    assert.match(scanned.body, /Срок поставки:\s*\{\{completion_terms\}\}/);
    assert.equal(scanned.fields.find((field) => field.key === "prepayment_amount")?.found, false);
    assert.equal(scanned.fields.find((field) => field.key === "amount")?.found, true);
    assert.equal(scanned.fields.find((field) => field.key === "completion_terms")?.found, true);
  });

  it("вписывает поля в исходный Word, сохраняя пункты шаблона", async () => {
    const bytes = await makeDocx(SAMPLE);
    const scanned = scanContractTemplateText(SAMPLE, {
      legalName: "ТОО CREOLAB",
      bin: "123456789013",
    });
    const rewritten = await rewriteDocxText(bytes, (text) => rewriteScannedFragment(text, scanned));
    const { ensureDocxItemsPlaceholder } = await import("./services/docxTemplateFill.ts");
    const withItems = await ensureDocxItemsPlaceholder(rewritten);
    const asTemplate = await docxToText(withItems);
    assert.match(asTemplate, /\{\{seller_name\}\}/);
    assert.match(asTemplate, /\{\{buyer_name\}\}/);
    assert.match(asTemplate, /\{\{items_table\}\}/);
    assert.match(asTemplate, /Разработать презентацию компании/);
    assert.match(asTemplate, /РЕКВИЗИТЫ СТОРОН/);
    const filled = await fillDocxPlaceholders(withItems, {
      seller_name: "ТОО Creolab",
      buyer_name: "ТОО Minerals Supply Services Atyrau",
      seller_bin: "221140036408",
      buyer_bin: "140540016755",
      contract_number: "DOG-2026-0005",
      contract_date: "«19» сентября 2026 г.",
      amount: "200 000,00 ₸",
      amount_words: "двести тысяч тенге",
      prepayment_amount: "100 000",
      prepayment_amount_words: "Сто тысяч",
      remainder_amount: "100 000",
      remainder_amount_words: "Сто тысяч",
    });
    const asContract = await docxToText(filled);
    assert.match(asContract, /ТОО Creolab/);
    assert.match(asContract, /Minerals Supply Services Atyrau/);
    assert.match(asContract, /Разработать презентацию компании/);
    assert.match(asContract, /DOG-2026-0005/);
    assert.match(asContract, /100 000 \(Сто тысяч\) тенге/);
    assert.doesNotMatch(asContract, /05082026/);
    assert.doesNotMatch(asContract, /60 000/);
    assert.doesNotMatch(asContract, /\{\{seller_name\}\}/);
    assert.doesNotMatch(asContract, /5\.\s*Заключительные положения/);
  });

  it("не обрезает буквы, склеивает поля из разных run и пишет современный Word", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    );
    zip.file(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    );
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:ind w:left="0" w:hanging="720"/></w:pPr><w:r><w:t>в</w:t></w:r><w:r><w:lastRenderedPageBreak/><w:t>ыполненных работ {{seller_name}}</w:t></w:r></w:p><w:p><w:r><w:t>{{</w:t></w:r><w:r><w:t>buyer_name</w:t></w:r><w:r><w:t>}}</w:t></w:r></w:p><w:p><w:r><w:t>{{items_table}}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="200" w:right="200" w:bottom="200" w:left="200"/></w:sectPr></w:body></w:document>`,
    );
    const bytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    const filled = await fillDocxPlaceholders(
      bytes,
      { seller_name: "ТОО Creolab", buyer_name: "ТОО Buyer" },
      [
        ["№", "Наименование", "Кол-во", "Ед.", "Цена", "Сумма"],
        ["1", "Презентация", "1", "шт", "100", "100"],
      ],
    );
    const out = await JSZip.loadAsync(filled);
    const doc = await out.file("word/document.xml")?.async("string");
    const settings = await out.file("word/settings.xml")?.async("string");
    const styles = await out.file("word/styles.xml")?.async("string");
    assert.ok(doc && settings && styles);
    assert.match(settings, /compatibilityMode[^>]*w:val="15"/);
    assert.match(settings, /doNotCompress/);
    assert.doesNotMatch(doc, /lastRenderedPageBreak/);
    assert.match(doc, /выполненных работ ТОО Creolab/);
    assert.match(doc, /ТОО Buyer/);
    assert.match(doc, /<w:tbl>/);
    assert.match(doc, /Презентация/);
    assert.doesNotMatch(doc, /w:hanging="720"/);
    assert.match(doc, /w:left="1134"/);
    const text = await docxToText(filled);
    assert.match(text, /выполненных работ ТОО Creolab/);
    assert.doesNotMatch(text, /^ыполненных/m);
  });

  it("подставляет номер, дату, 50% оплаты и позиции приложений в исходный Word", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>`,
    );
    zip.file(
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    );
    zip.file(
      "word/settings.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:writeProtection w:recommended="1"/><w:documentProtection w:edit="readOnly" w:enforcement="1"/></w:settings>`,
    );
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Договор №</w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:t>03092026/01</w:t></w:r></w:p>
<w:p><w:r><w:t>«3» сентября 2026 г.</w:t></w:r></w:p>
<w:p><w:r><w:t>4.5.1. Заказчик производит предоплату в размере 50% от Стоимости оказания Услуг, которая составляет 150 000 (Сто пятьдесят тысяч) тенге.</w:t></w:r></w:p>
<w:p><w:r><w:t>4.5.2. Заказчик обязан оплатить оставшиеся 50% от Стоимости оказанных Услуг, которая составляет 150 000 (Сто пятьдесят тысяч) тенге.</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Разработка презентации компании до 15 слайдов/страниц</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>300 000 тенге</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>№</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Вид Услуг, требования к результату</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Сроки выполнения</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Стоимость в тенге</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Разработка презентации компании до 15 слайдов/страниц</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>5-7 рабочих дней</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>300 000</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    );
    const bytes = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    const filled = await fillDocxPlaceholders(
      bytes,
      {
        contract_number: "DOG-2026-0008",
        contract_date: "«19» сентября 2026 г.",
        prepayment_amount: "100 000",
        prepayment_amount_words: "Сто тысяч",
        remainder_amount: "100 000",
        remainder_amount_words: "Сто тысяч",
        completion_terms: "10 рабочих дней",
      },
      [],
      {
        items: [{ name: "Дизайн сайта", totalAmount: 200000 }],
        completionTerms: "10 рабочих дней",
        totalAmount: 200000,
      },
    );
    const text = await docxToText(filled);
    assert.match(text, /DOG-2026-0008/);
    assert.match(text, /«19» сентября 2026/);
    assert.match(text, /Дизайн сайта/);
    assert.match(text, /10 рабочих дней/);
    assert.match(text, /100 000 \(Сто тысяч\) тенге/);
    assert.doesNotMatch(text, /03092026/);
    assert.doesNotMatch(text, /до 15 слайдов/);
    assert.doesNotMatch(text, /150 000/);
    const out = await JSZip.loadAsync(filled);
    const settings = await out.file("word/settings.xml")?.async("string");
    assert.ok(settings);
    assert.doesNotMatch(settings, /documentProtection/);
    assert.doesNotMatch(settings, /writeProtection/);
  });

  it("собирает Word-файл с позициями без PDF", async () => {
    const { renderContractDocx, isDocxBytes } = await import("./services/contractDocx.ts");
    const { DEFAULT_CONTRACT_BODY } = await import("./services/contractTemplate.ts");
    const bytes = await renderContractDocx({
      number: "DOG-2026-0009",
      date: new Date("2026-09-19T00:00:00Z"),
      subject: "Разработка презентации",
      dealName: "Презентация",
      paymentTerms: "100% после подписания",
      completionTerms: "10 дней",
      amountWithoutVat: 200000,
      vatRate: null,
      vatAmount: 0,
      totalAmount: 200000,
      sellerName: "ТОО Creolab",
      sellerBin: "221140036408",
      sellerAddress: "Алматы",
      sellerDirector: "Булан А. Б.",
      sellerDirectorPosition: "Директор",
      buyerName: "ТОО Minerals Supply Services Atyrau",
      buyerBin: "140540016755",
      buyerAddress: "Атырау",
      buyerDirector: "Мухсинов Е. Н.",
      items: [{ name: "Разработка презентации компании", quantity: 1, unit: "шт", unitPrice: 200000, totalAmount: 200000 }],
      templateBody: DEFAULT_CONTRACT_BODY,
    });
    assert.ok(isDocxBytes(bytes));
    const text = await docxToText(bytes);
    assert.match(text, /Разработка презентации компании/);
    assert.match(text, /Minerals Supply Services Atyrau/);
    assert.match(text, /200\s*000/);
    assert.doesNotMatch(text, /\{\{/);
  });

  it("читает unicode-текст из OLE .doc без LibreOffice", () => {
    const payload = Buffer.from(SAMPLE, "utf16le");
    const bytes = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(32),
      payload,
    ]);
    const text = extractDocUnicodeText(bytes);
    assert.match(text, /Разработать презентацию компании/);
    assert.match(text, /АрыстанТехСервис/);
  });

  it("не показывает названия стилей Word вместо текста договора", () => {
    const junk = "Текст примечания\nТекст примечания Знак\nСетка таблицы\nБез интервала\nОсновной текст 2 Знак\nРецензия\n";
    const bytes = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.from(junk, "utf16le"),
      Buffer.alloc(2),
      Buffer.from(SAMPLE, "utf16le"),
    ]);
    const text = extractDocUnicodeText(bytes);
    assert.doesNotMatch(text, /Сетка таблицы/);
    assert.doesNotMatch(text, /Текст примечания/);
    assert.doesNotMatch(text, /Основной текст 2/);
    assert.match(text, /Разработать презентацию компании/);
    assert.match(text, /РЕКВИЗИТЫ СТОРОН/);
  });

  before(async () => {
    process.env.SEED_PASSWORD ||= "ChangeMeLocal1!";
    prisma = await createPrismaClient();
    const { seedDatabase } = await import("../../../packages/db/src/seed.ts");
    await seedDatabase();
    app = createApp(prisma);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = (server as { address: () => { port: number } }).address();
    base = `http://127.0.0.1:${address.port}`;
    const login = await json("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "owner@creolab.example", password: process.env.SEED_PASSWORD, client: "web" }),
    }, "");
    cookie = login.response.headers.get("set-cookie") || "";
    const demo = await json("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email: "owner@demo-agency.example", password: process.env.SEED_PASSWORD, client: "web" }),
    }, "");
    otherCookie = demo.response.headers.get("set-cookie") || "";
    await json("/api/v1/settings/legal-profile", {
      method: "PATCH",
      body: JSON.stringify({
        legalName: "ТОО CREOLAB",
        bin: "123456789013",
        legalAddress: "г. Алматы, пр. Абая 1",
        directorName: "Иванов Иван",
        directorPosition: "Директор",
        iban: "KZ111111111111111111",
        bankName: "АО «Банк ЦентрКредит»",
        bik: "KCJBKZKX",
        defaultVatMode: "none",
      }),
    });
  });

  after(() => {
    server?.close();
  });

  it("загружает Word, сохраняет шаблон и формирует договор по компании", async () => {
    const bytes = await makeDocx(SAMPLE);
    const preview = await json("/api/v1/documents/contract-templates/preview", {
      method: "POST",
      body: JSON.stringify({
        fileName: "Договор на возмездные услуги.docx",
        fileBase64: bytes.toString("base64"),
      }),
    });
    assert.equal(preview.response.status, 200, JSON.stringify(preview.body));
    assert.match(preview.body.body, /\{\{buyer_name\}\}/);
    assert.match(preview.body.body, /Разработать презентацию компании/);

    const created = await json("/api/v1/documents/contract-templates", {
      method: "POST",
      body: JSON.stringify({
        name: "Договор на разработку презентации",
        body: preview.body.body,
        isDefault: true,
        fileName: "Договор на возмездные услуги.docx",
        fileBase64: bytes.toString("base64"),
      }),
    });
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.template.fromWord, true);
    const templateId = created.body.template.id;
    const hidden = await json(`/api/v1/documents/contract-templates/${templateId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "Чужой шаблон" }),
    }, otherCookie);
    assert.equal(hidden.response.status, 404);

    const company = await json("/api/v1/companies", {
      method: "POST",
      body: JSON.stringify({
        name: "ТОО АрыстанТехСервис",
        legalName: "ТОО АрыстанТехСервис",
        bin: "222222222220",
        legalAddress: "г. Астана, ул. Сыганак 4",
        directorName: "Шайдуллинов Р. К.",
        iban: "KZ5396503F0007969139",
        bankName: "АО ForteBank",
        bik: "IRTYKZKA",
        forceCreate: true,
      }),
    });
    assert.equal(company.response.status, 201, JSON.stringify(company.body));

    const formed = await json(`/api/v1/companies/${company.body.id}/contract-from-template`, {
      method: "POST",
      body: JSON.stringify({ templateId }),
    });
    assert.equal(formed.response.status, 201, JSON.stringify(formed.body));
    assert.equal(formed.body.dealId, null);
    assert.ok(formed.body.previewId);
    assert.equal(formed.body.generated, true, JSON.stringify(formed.body));

    const previewFile = await fetch(`${base}/api/v1/documents/contract-previews/${formed.body.previewId}`, { headers: { cookie } });
    assert.equal(previewFile.status, 200);
    const previewBytes = Buffer.from(await previewFile.arrayBuffer());
    assert.ok(previewBytes.subarray(0, 2).equals(Buffer.from("PK")));
    const previewText = await docxToText(previewBytes);
    assert.match(previewText, /Разработать презентацию компании/);
    assert.match(previewText, /реквизит/i);
    assert.doesNotMatch(previewText, /5\.\s*Заключительные положения/);

    const saved = await json(`/api/v1/companies/${company.body.id}/contract-from-template`, {
      method: "POST",
      body: JSON.stringify({ save: true, previewId: formed.body.previewId }),
    });
    assert.equal(saved.response.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.contract.templateId, templateId);
    assert.ok(saved.body.dealId);
    assert.equal(saved.body.contract.status, "READY_TO_SIGN");

    const file = await fetch(`${base}/api/v1/contracts/${saved.body.contract.id}/pdf`, { headers: { cookie } });
    assert.equal(file.status, 200);
    const fileBytes = Buffer.from(await file.arrayBuffer());
    assert.ok(fileBytes.subarray(0, 2).equals(Buffer.from("PK")));
    const wordText = await docxToText(fileBytes);
    assert.match(wordText, /Разработать презентацию компании/);
    assert.match(wordText, /реквизит/i);
    assert.doesNotMatch(wordText, /5\.\s*Заключительные положения/);

    const list = await json("/api/v1/documents/contract-templates");
    assert.ok((list.body.items || []).some((row: { id: string }) => row.id === templateId));
  });

  it("формирует договор с услугами и выбранным НДС даже без НДС в настройках", async () => {
    await json("/api/v1/settings/legal-profile", {
      method: "PATCH",
      body: JSON.stringify({ defaultVatMode: null, defaultVatRate: null }),
    });
    const list = await json("/api/v1/documents/contract-templates");
    const templateId = (list.body.items || []).find((row: { isDefault?: boolean }) => row.isDefault)?.id
      || (list.body.items || [])[0]?.id;
    assert.ok(templateId);
    const companies = await json("/api/v1/companies");
    const companyId = (companies.body.items || companies.body.companies || [])[0]?.id;
    assert.ok(companyId, JSON.stringify(companies.body));
    const formed = await json(`/api/v1/companies/${companyId}/contract-from-template`, {
      method: "POST",
      body: JSON.stringify({
        templateId,
        items: [
          { name: "Разработка презентации", quantity: 1, unitPrice: 120000, vatRate: 12 },
          { name: "Доп. слайды", quantity: 3, unitPrice: 20000, vatRate: 0 },
        ],
      }),
    });
    assert.equal(formed.response.status, 201, JSON.stringify(formed.body));
    const saved = await json(`/api/v1/companies/${companyId}/contract-from-template`, {
      method: "POST",
      body: JSON.stringify({ save: true, previewId: formed.body.previewId }),
    });
    assert.equal(saved.response.status, 201, JSON.stringify(saved.body));
    const deal = await json(`/api/v1/deals/${saved.body.dealId}`);
    assert.equal(deal.response.status, 200, JSON.stringify(deal.body));
    const items = deal.body.deal?.items || [];
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "Разработка презентации");
    assert.equal(items[0].vatRate, 12);
    assert.equal(items[1].vatRate, 0);
  });

  it("не отдаёт шаблон другой компании", async () => {
    const list = await json("/api/v1/documents/contract-templates", {}, otherCookie);
    assert.equal(list.response.status, 200);
    assert.equal(
      (list.body.items || []).some((row: { name: string }) => /презентац/i.test(row.name)),
      false,
    );
  });
});
