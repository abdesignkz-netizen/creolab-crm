import { parentPort, workerData } from "node:worker_threads";
import { extractKnowledgeFile } from "./knowledgeFileText.ts";
import { ApiError } from "../errors.ts";

if (parentPort) {
  try {
    const result = await extractKnowledgeFile(workerData.fileName, Buffer.from(workerData.bytes), workerData.temporaryRoot);
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ error: error instanceof ApiError ? { code: error.code, message: error.message, status: error.status }
      : { code: "knowledge_file_invalid", message: "Не удалось прочитать файл. Проверьте формат и содержимое или сохраните материал в PDF.", status: 422 } });
  }
}
