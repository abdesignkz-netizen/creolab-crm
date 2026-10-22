import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";

if (process.argv[2] === "--case") {
  const { extractKnowledgeFileIsolated } = await import("../../apps/api/src/services/aiKnowledgeImportService.ts");
  const file = process.argv[3], bytes = await readFile(file);
  const baseline = process.memoryUsage().rss; let peak = baseline;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
  const delay = monitorEventLoopDelay({ resolution: 10 }); delay.enable();
  const started = performance.now();
  try {
    const result = await extractKnowledgeFileIsolated(path.basename(file), bytes);
    process.stdout.write(JSON.stringify({ file: path.basename(file), bytes: bytes.length, elapsedMs: Math.round(performance.now() - started), baselineMiB: +(baseline / 1048576).toFixed(1), peakMiB: +(peak / 1048576).toFixed(1), mainLoopMaxMs: +(delay.max / 1e6).toFixed(1), pages: result.pages, ocr: result.ocr, characters: result.content.length }) + "\n");
  } catch (error) { process.stdout.write(JSON.stringify({ file: path.basename(file), error: String(error), peakMiB: +(peak / 1048576).toFixed(1) }) + "\n"); process.exitCode = 1; }
  finally { clearInterval(timer); delay.disable(); }
} else {
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const { createCanvas } = await import("@napi-rs/canvas");
  const scratch = await mkdtemp(path.join(tmpdir(), "basqar-knowledge-fixtures-"));
  const fixtures: string[] = [];
  async function save(name: string, bytes: Uint8Array) { const file = path.join(scratch, name); await writeFile(file, bytes); fixtures.push(file); }
  const textPdf = await PDFDocument.create(), font = await textPdf.embedFont(StandardFonts.Helvetica);
  for (let p = 1; p <= 20; p++) {
    const page = textPdf.addPage(); page.drawText(`Knowledge catalog - page ${p}`, { font, size: 18, x: 35, y: 790 });
    for (let row = 0; row < 35; row++) page.drawText(`Service ${p}-${row + 1} | Price: 50000 KZT | Delivery: 3 working days`, { font, size: 10, x: 35, y: 755 - row * 19 });
  }
  const textBytes = await textPdf.save(); await save("text-20-pages.pdf", textBytes);
  // The same valid PDF at the exact upload boundary, to measure copying and decoding overhead.
  await save("text-10-MiB.pdf", Buffer.concat([textBytes, Buffer.from("\n%"), Buffer.alloc(10 * 1048576 - textBytes.length - 2, 32)]));
  for (const pages of [5, 20]) {
    const pdf = await PDFDocument.create();
    for (let p = 1; p <= pages; p++) {
      const canvas = createCanvas(1240, 1754), ctx = canvas.getContext("2d");
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, 1240, 1754); ctx.fillStyle = "black"; ctx.font = "bold 40px Arial";
      ctx.fillText(`ASpan Studio services - page ${p}`, 55, 100); ctx.font = "28px Arial";
      for (let row = 0; row < 23; row++) ctx.fillText(`Service ${row + 1}. Price: 50000 KZT. Delivery: 3 days.`, 55, 180 + row * 60);
      const image = await pdf.embedJpg(canvas.toBuffer("image/jpeg")); const page = pdf.addPage([595, 842]);
      page.drawImage(image, { x: 0, y: 0, width: 595, height: 842 }); canvas.width = 1; canvas.height = 1;
    }
    await save(`scanned-${pages}-pages.pdf`, await pdf.save());
  }
  const canvas = createCanvas(4000, 3000), ctx = canvas.getContext("2d");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, 4000, 3000); ctx.fillStyle = "black"; ctx.font = "90px Arial";
  ctx.fillText("ASpan Studio services", 150, 350);
  for (let row = 0; row < 12; row++) ctx.fillText(`Website: 50000 KZT. Delivery: 3 days.`, 150, 600 + row * 175);
  await save("image-12-megapixels.jpg", canvas.toBuffer("image/jpeg"));
  await save("image-12-megapixels.png", canvas.toBuffer("image/png"));
  canvas.width = 1; canvas.height = 1;
  const results: unknown[] = [];
  for (const fixture of fixtures) {
    const output = spawnSync(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), "--case", fixture], { encoding: "utf8", timeout: 100000, maxBuffer: 1048576, env: { ...process.env, NODE_ENV: "test", OPENAI_API_KEY: "", ANYMODEL_API_KEY: "" } });
    const line = output.stdout?.trim().split("\n").findLast(line => line.startsWith("{"));
    const result = line ? JSON.parse(line) : { file: path.basename(fixture), error: String(output.error || output.stderr) };
    results.push(result); process.stdout.write(JSON.stringify(result) + "\n");
  }
  await writeFile(new URL("./results.json", import.meta.url), JSON.stringify({ node: process.version, arch: process.arch, date: new Date().toISOString(), environment: "isolated local workers, not production API", results }, null, 2));
}
