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
