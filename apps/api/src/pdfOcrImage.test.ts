import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import PDFDocument from "pdfkit";
import type { Page } from "tesseract.js";
import { grayscaleImage, needsDetailedOcr, ocrScale, preferDetailedOcr } from "./services/pdfOcrImage.ts";
import { extractPdfPages } from "./services/pdfTextExtraction.ts";

function result(text: string, confidence: number, words: Array<{text: string; confidence: number}> = []) {
  return { text, confidence, blocks: [{ paragraphs: [{ lines: [{ words }] }] }] } as Page;
}
const clearText = "Contract for presentation design and printing. Total 400000 KZT.";

describe("Memory-bounded OCR images", () => {
  it("preserves faint shades and composites transparency onto white in an 8-bit image", () => {
    const canvas = createCanvas(4, 1);
    try {
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "black"; ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = "rgb(220,220,220)"; ctx.fillRect(1, 0, 1, 1);
      ctx.fillStyle = "red"; ctx.fillRect(2, 0, 1, 1);
      const image = grayscaleImage(canvas);
      const header = Buffer.from("P5\n4 1\n255\n");
      assert.deepEqual(image.subarray(0, header.length), header);
      assert.deepEqual([...image.subarray(header.length)], [0, 220, 76, 255]);
    } finally { canvas.width = 1; canvas.height = 1; }
  });
  it("caps pixel count and longest side for portrait, landscape and extreme aspect ratios", () => {
    for (const [w, h] of [[595,842], [842,595], [100,29000], [29000,100]]) {
      for (const detailed of [false, true]) {
        const scale = ocrScale(w, h, detailed);
        assert.ok(w * h * scale * scale <= (detailed ? 4_000_000 : 2_000_000) + 0.001);
        assert.ok(Math.max(w,h) * scale <= (detailed ? 2600 : 1800));
      }
      assert.ok(ocrScale(w,h,true) > ocrScale(w,h,false));
    }
  });
  it("keeps clear pages at low resolution but retries uncertain text and numbers", () => {
    assert.equal(needsDetailedOcr(result(clearText, 92)), false);
    assert.equal(needsDetailedOcr(result(clearText, 62)), true);
    assert.equal(needsDetailedOcr(result("", 0)), true);
    assert.equal(needsDetailedOcr(result(clearText, 92, [{text:"400000",confidence:55}])), true);
  });
  it("retains the first result when the detailed retry loses text or lowers confidence", () => {
    const initial = result(clearText, 80);
    assert.equal(preferDetailedOcr(initial, result("Total", 98)), false);
    assert.equal(preferDetailedOcr(initial, result(clearText, 65)), false);
    assert.equal(preferDetailedOcr(initial, result(clearText, 91)), true);
    assert.equal(preferDetailedOcr(result("",0), initial), true);
  });
  it("reads a pale/color scan between text pages without losing amounts or reusing another page's text", async () => {
    const pdf = new PDFDocument({ size: "A4" });
    const chunks: Buffer[] = [];
    const bytes = new Promise<Buffer>((resolve, reject) => {
      pdf.on("data", c => chunks.push(c));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));
      pdf.on("error", reject);
    });
    pdf.text("Original text page before the scanned contract. Reference FIRST-PAGE.");
    pdf.addPage();
    const canvas = createCanvas(1400, 900);
    try {
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1400, 900);
      ctx.font = "42px Arial";
      ctx.fillStyle = "rgb(195,195,195)"; ctx.fillText("Contract No 2026-TEST-42", 70, 150);
      ctx.fillStyle = "#315596"; ctx.fillText("Total: 400000 KZT", 70, 260);
      pdf.image(canvas.toBuffer("image/png"), 40, 40, { width: 510 });
    } finally { canvas.width = 1; canvas.height = 1; }
    pdf.addPage().text("Original text page after the scanned contract. Reference LAST-PAGE.");
    pdf.end();
    const pages = await extractPdfPages(await bytes);
    assert.deepEqual(pages.map(p => p.ocr), [false, true, false]);
    assert.match(pages[0].text, /FIRST-PAGE/);
    assert.match(pages[1].text, /2026.TEST.42/);
    assert.match(pages[1].text, /400000/);
    assert.match(pages[2].text, /LAST-PAGE/);
    assert.doesNotMatch(pages[2].text, /400000/);
  });
});
