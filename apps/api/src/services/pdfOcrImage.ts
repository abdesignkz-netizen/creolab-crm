import type { Canvas } from "@napi-rs/canvas";
import type { Page } from "tesseract.js";

// Bound both dimensions and area, including unusually tall/wide PDF pages.
export function ocrScale(width: number, height: number, detailed = false) {
  const longestSide = detailed ? 2600 : 1800;
  const pixels = detailed ? 4_000_000 : 2_000_000;
  return Math.min(detailed ? 2.6 : 1.7, longestSide / Math.max(width, height), Math.sqrt(pixels / (width * height)));
}

/** PGM is lossless 8-bit grayscale, read directly by Tesseract/Leptonica.
 * Read small strips so conversion never allocates another full RGBA image.
 * Keep intermediate shades (including faint text); composite transparency on white.
 */
export function grayscaleImage(canvas: Canvas): Buffer {
  const { width, height } = canvas;
  const header = Buffer.from(`P5\n${width} ${height}\n255\n`);
  const image = Buffer.allocUnsafe(header.length + width * height);
  header.copy(image);
  const context = canvas.getContext("2d");
  for (let y = 0; y < height; y += 32) {
    const strip = context.getImageData(0, y, width, Math.min(32, height - y)).data;
    for (let i = 0; i < strip.length; i += 4) {
      const gray = (299 * strip[i] + 587 * strip[i + 1] + 114 * strip[i + 2]) / 1000;
      image[header.length + y * width + i / 4] = Math.round(255 + (gray - 255) * strip[i + 3] / 255);
    }
  }
  return image;
}

function recognizedWords(result: Page) {
  return (result.blocks || []).flatMap(b => b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words)))
    .filter(w => /[\p{L}\p{N}]{2}/u.test(w.text));
}

export function needsDetailedOcr(result: Page) {
  if (result.text.replace(/\s/g, "").length < 40 || result.confidence < 75) return true;
  const words = recognizedWords(result);
  // A good page average can hide an uncertain amount or account number.
  return words.some(w => /\d{2}/.test(w.text) && w.confidence < 80)
    || words.filter(w => w.confidence < 60).length > words.length * 0.15;
}

export function preferDetailedOcr(initial: Page, detailed: Page) {
  const initialLetters = initial.text.replace(/[^\p{L}\p{N}]/gu, "").length;
  const detailedLetters = detailed.text.replace(/[^\p{L}\p{N}]/gu, "").length;
  // Higher confidence alone must not select a mostly empty retry.
  if (detailedLetters < initialLetters * 0.8 || !detailedLetters) return false;
  return detailed.confidence >= initial.confidence || detailedLetters > initialLetters * 1.15;
}
