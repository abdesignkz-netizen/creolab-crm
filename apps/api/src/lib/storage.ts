import { mkdir } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.ts";

const PERSISTENT_PREFIXES = ["/var/data", "/data", "/mnt"];

export function classifyStorePathKind(
  storageDir: string,
  options?: { cwd?: string; persistentFlag?: string | null },
): "persistent" | "ephemeral" {
  const flag = String(options?.persistentFlag ?? "").trim().toLowerCase();
  if (flag === "1" || flag === "true" || flag === "yes") return "persistent";

  const dir = String(storageDir || "").trim();
  if (!dir) return "ephemeral";

  const resolved = path.resolve(dir).replace(/\\/g, "/");
  for (const prefix of PERSISTENT_PREFIXES) {
    if (resolved === prefix || resolved.startsWith(`${prefix}/`)) return "persistent";
  }

  if (path.isAbsolute(dir)) {
    const cwd = path.resolve(options?.cwd || process.cwd()).replace(/\\/g, "/");
    if (resolved !== cwd && !resolved.startsWith(`${cwd}/`)) return "persistent";
  }

  return "ephemeral";
}

export function uploadsRoot() {
  if (config.storageDir) {
    return path.resolve(config.storageDir, "uploads");
  }
  return path.resolve(process.cwd(), "data", "uploads");
}

export function crmStorePathKind(): "persistent" | "ephemeral" {
  return classifyStorePathKind(config.storageDir, {
    persistentFlag: process.env.STORAGE_PERSISTENT,
  });
}

export function fileStorageStatus() {
  const storePathKind = crmStorePathKind();
  return {
    storePathKind,
    uploadsRoot: uploadsRoot(),
    storageDir: config.storageDir || null,
    warning:
      storePathKind === "ephemeral"
        ? "Файлы задач на эфемерном диске — после рестарта Render КП пропадут. Подключите Persistent Disk и задайте STORAGE_DIR=/var/data/files."
        : null,
  };
}

export function missingFileMessage() {
  const status = fileStorageStatus();
  if (status.storePathKind === "ephemeral") {
    return "Файл не найден на сервере (хранилище без persistent disk — файлы пропадают после рестарта). Прикрепите КП заново и повторите отправку.";
  }
  return "Файл не найден на сервере. Прикрепите КП заново и повторите отправку.";
}

export function resolveUploadPath(storageKey: string) {
  if (!storageKey) return storageKey;
  if (path.isAbsolute(storageKey)) return storageKey;
  return path.join(uploadsRoot(), ...storageKey.split("/").filter(Boolean));
}

export async function ensureUploadsRoot() {
  await mkdir(uploadsRoot(), { recursive: true });
  return fileStorageStatus();
}
