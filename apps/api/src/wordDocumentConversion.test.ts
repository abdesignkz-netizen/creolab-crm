import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { wordToPdf } from "./services/wordDocumentConversion.ts";
import { ApiError } from "./errors.ts";

describe("Word conversion errors", () => {
  const originalPath = process.env.CRM_SOFFICE_PATH;
  let scratch: string;
  after(async () => {
    if (originalPath === undefined) delete process.env.CRM_SOFFICE_PATH;
    else process.env.CRM_SOFFICE_PATH = originalPath;
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it("distinguishes a missing converter from an unreadable document", async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "crm-word-errors-"));
    const word = await readFile(new URL("./fixtures/manual-word-contract.docx", import.meta.url));
    process.env.CRM_SOFFICE_PATH = path.join(scratch, "missing-soffice");
    await assert.rejects(wordToPdf(word, "docx"), (error: unknown) =>
      error instanceof ApiError && error.code === "word_conversion_unavailable");

    // LibreOffice can exit successfully without producing a PDF for an unreadable file.
    const converter = path.join(scratch, "soffice");
    await writeFile(converter, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    process.env.CRM_SOFFICE_PATH = converter;
    await assert.rejects(wordToPdf(word, "docx"), (error: unknown) =>
      error instanceof ApiError && error.code === "word_conversion_failed");
  });
});
