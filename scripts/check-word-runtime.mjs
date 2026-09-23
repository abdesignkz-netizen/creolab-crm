// Run inside the deployment image, not only on the developer's machine.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { wordToPdf } from "../apps/api/src/services/wordDocumentConversion.ts";

for (const extension of ["docx", "doc"]) {
  const bytes = await readFile(new URL(`../apps/api/src/fixtures/manual-word-contract.${extension}`, import.meta.url));
  const pdf = await wordToPdf(bytes, extension);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  console.log(`Word runtime: ${extension.toUpperCase()} → PDF OK`);
}

// Check the generated document as well: raw Word input alone does not exercise
// placeholder replacement or nested service tables.
const { fillDocxPlaceholders } = await import("../apps/api/src/services/docxTemplateFill.ts");
const source = await readFile(new URL("../apps/api/src/fixtures/nested-table-contract.docx", import.meta.url));
const generated = await fillDocxPlaceholders(source, {
  contract_number: "RUNTIME-CHECK", seller_name: "Исполнитель", buyer_name: "Заказчик",
}, [], { items: [{ name: "Проверка формирования", totalAmount: 200000 }], totalAmount: 200000 });
const generatedPdf = await wordToPdf(generated, "docx");
assert.equal(generatedPdf.subarray(0, 5).toString(), "%PDF-");
console.log("Word runtime: generated template with nested tables → PDF OK");
