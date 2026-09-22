import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ApiError } from "../errors.ts";

const run = promisify(execFile);
export async function wordToPdf(bytes: Buffer, extension: "doc" | "docx") {
  const valid = extension === "docx" ? bytes.subarray(0,4).equals(Buffer.from([80,75,3,4]))
    : bytes.subarray(0,8).equals(Buffer.from([208,207,17,224,161,177,26,225]));
  if (!valid) throw new ApiError(422, "word_invalid", "Файл не соответствует формату Word. Выберите .docx или .doc");
  const dir = await mkdtemp(path.join(tmpdir(), "crm-word-"));
  try {
    const profile = path.join(dir, "profile");
    await mkdir(path.join(profile, "user"), { recursive: true });
    // Fresh profile: never execute document macros or update external links.
    await writeFile(path.join(profile, "user", "registrymodifications.xcu"), `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item></oor:items>`);
    const input = path.join(dir, `contract.${extension}`);
    await writeFile(input, bytes);
    try {
      const args = [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--nologo", "--nodefault", "--norestore", "--convert-to", "pdf:writer_pdf_Export", "--outdir", dir, input];
      try {
        await run(process.env.CRM_SOFFICE_PATH || "soffice", args, { timeout: 30_000, maxBuffer: 512_000 });
        await readFile(path.join(dir, "contract.pdf"));
      } catch (error) {
        // Some older packages are not recognized by automatic format detection.
        // Retry with the Word import filter; the source document is never rewritten.
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && (error as { syscall?: string }).syscall?.startsWith("spawn")) throw error;
        await run(process.env.CRM_SOFFICE_PATH || "soffice", [
          ...args.slice(0, 5), `--infilter=${extension === "docx" ? "Office Open XML Text" : "MS Word 97"}`, ...args.slice(5),
        ], { timeout: 30_000, maxBuffer: 512_000 });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(422, "word_conversion_unavailable", "Преобразование Word временно недоступно. Пока загрузите PDF-копию договора.");
      throw error;
    }
    const pdf = await readFile(path.join(dir, "contract.pdf"));
    if (!pdf.subarray(0,5).equals(Buffer.from("%PDF-")) || pdf.length > 20*1024*1024) throw new Error("invalid output");
    return pdf;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "word_conversion_failed", "Не удалось открыть Word. Проверьте, что файл не повреждён и не защищён паролем, либо сохраните его как PDF.");
  } finally { await rm(dir, { recursive:true, force:true }); }
}
