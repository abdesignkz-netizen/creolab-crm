import { ApiError } from "../errors.ts";

const MiB = 1024 * 1024;
// Worker.resourceLimits bounds V8 only; image buffers and OCR/WASM use additional memory.
const headroom = { text: 96 * MiB, document: 256 * MiB, image: 512 * MiB, ocr: 320 * MiB };
export function ensureKnowledgeImportMemory(stage: keyof typeof headroom, memory = {
  constrained: process.constrainedMemory(), available: process.availableMemory(),
}) {
  // An unconstrained desktop's "free" RAM excludes reclaimable caches. Do not
  // mistake that value for a hosting/container memory limit.
  if (memory.constrained > 0 && memory.available < headroom[stage]) {
    throw new ApiError(503, "knowledge_import_resources", "Сейчас серверу не хватает свободной памяти для обработки материала. Попробуйте позже или загрузите нужный текст в TXT / MD. Если ошибка повторяется, обратитесь к администратору сервиса.");
  }
}
