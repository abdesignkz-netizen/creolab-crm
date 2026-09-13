import type { PdfImportDraft } from "@creolab/contracts";

export function invoicePayment(text: string) {
  const kinds: Array<[NonNullable<PdfImportDraft["paymentKind"]>,RegExp]> = [
    ["PREPAYMENT", /(?<![а-яё])(?:предоплат|аванс)/i],
    ["BALANCE", /остат(?:ок|ка)|окончательн[а-яё]*\s+(?:оплат|расч[её]т)|(?<![а-яё])доплат/i],
    ["ADDITIONAL", /доп\.?\s*объ[её]м|дополнительн[а-яё]*\s+(?:работ|услуг|объ[её]м)/i],
    ["FULL", /полная\s+оплата|(?<![а-яё])оплата\s*(?:в размере\s*)?100\s*%/i],
  ];
  const matched=kinds.filter(([,re])=>re.test(text));
  return {paymentKind:matched.length===1?matched[0][0]:"UNSPECIFIED" as const,
    paymentTerms:[...new Set(text.split("\n").filter(line=>kinds.some(([,re])=>re.test(line)) || /назначение платежа|условия оплаты/i.test(line)).map(l=>l.trim()))].join("; ").slice(0,4000)};
}
