import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const postgres = process.argv.includes("--postgres");
const requested = new Set(process.argv.slice(2).filter(value => value !== "--postgres").map(value => value.replace(/\.test\.ts$/, "")));
function testFiles(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry =>
    entry.isDirectory() ? testFiles(join(dir, entry.name)) : entry.name.endsWith(".test.ts") ? [join(dir, entry.name)] : []);
}
const available = ["apps/api/src", "packages/contracts/src"].flatMap(testFiles);
const names = new Set(available.map(file => file.split("/").at(-1).replace(/\.test\.ts$/, "")));
const unknown = [...requested].filter(name => !names.has(name));
if (unknown.length) throw new Error(`Unknown test files: ${unknown.join(", ")}`);
const files = available
  .filter(file => (postgres || !file.endsWith(".postgres.test.ts")) && (!requested.size || requested.has(file.split("/").at(-1).replace(/\.test\.ts$/, ""))));
if (!files.length) throw new Error("No matching test files");
let admin, postgresUrl;
const createdDatabases = [];
if (postgres) {
  postgresUrl = new URL(process.env.BASQAR_TEST_POSTGRES_URL || "invalid:");
  if (!/^postgres(ql)?:$/.test(postgresUrl.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(postgresUrl.hostname)
      || postgresUrl.pathname !== "/postgres" || postgresUrl.search || postgresUrl.hash || postgresUrl.port === "55432") {
    throw new Error("--postgres requires BASQAR_TEST_POSTGRES_URL for a loopback PostgreSQL /postgres database (not port 55432). DATABASE_URL is never used as the test target.");
  }
  const { PrismaClient } = await import("@prisma/client");
  admin = new PrismaClient({ datasourceUrl: postgresUrl.href });
}
const scratch = mkdtempSync(join(tmpdir(), "creolab-tests-"));
let failures = 0;
const failedFiles = [];
try {
  for (const [index, file] of files.entries()) {
    const env = {
        ...process.env,
        NODE_ENV: "test",
        BILLING_PROVIDER: "none",
        FREEDOM_PAY_MERCHANT_ID: "",
        FREEDOM_PAY_SECRET_KEY: "",
        FREEDOM_PAY_RECURRING_ENABLED: "0",
        FREEDOM_PAY_TESTING_MODE: "1",
        BILLING_KASPI_MANUAL_ENABLED: "0",
        CRM_USE_PGLITE: postgres ? "0" : "1",
        CRM_TEST_POSTGRES: postgres ? "1" : "0",
        CRM_PGLITE_DIR: join(scratch, String(index)),
        STORAGE_DIR: join(scratch, "uploads", String(index)),
        SEED_PASSWORD: "ChangeMeLocal1!",
        PLATFORM_ADMIN_EMAIL: "",
        PLATFORM_ADMIN_PASSWORD: "",
        WHATSAPP_SELLER_URL: "",
        WHATSAPP_SELLER_SECRET: "",
        AI_MANAGER_URL: "",
        ESF_PROVIDER: "mock",
        ESF_ENV: "off",
        ESF_ALLOW_LIVE_SEND: "0",
        TELEGRAM_BOT_TOKEN: "",
        TELEGRAM_BOT_USERNAME: "",
        TELEGRAM_WEBHOOK_SECRET: "",
        TELEGRAM_WEBHOOK_BASE_URL: "",
        VAPID_PUBLIC_KEY: "",
        VAPID_PRIVATE_KEY: "",
        OPENAI_API_KEY: "",
        ANYMODEL_API_KEY: "",
        TRANSCRIPTION_API_KEY: "",
        TRANSCRIPTION_ENGINE: "local",
        TRANSCRIPTION_PYTHON: "/nonexistent/basqar-test-python",
        TRANSCRIPTION_MODEL_PATH: "/nonexistent/basqar-test-speech-model",
    };
    if (postgres) {
      const name = `basqar_test_${randomBytes(8).toString("hex")}_${index}`;
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
      createdDatabases.push(name);
      const url = new URL(postgresUrl); url.pathname = `/${name}`;
      env.DATABASE_URL = url.href;
      // Exercise the shipped baseline plus the real startup migrations, not db
      // push: the checksummed billing migration must run before its new columns exist.
      const initialized = spawnSync(process.execPath, ["node_modules/prisma/build/index.js", "db", "execute", "--schema", "packages/db/prisma/schema.prisma", "--file", "packages/db/prisma/init.sql"], { cwd: root, stdio: "inherit", env });
      if (initialized.status !== 0) throw new Error(`PostgreSQL baseline failed for ${file}`);
    }
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--test", file], { cwd: root, stdio: "inherit", env });
    if (result.status !== 0) { failures += 1; failedFiles.push(file); }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
  if (admin) {
    try {
      for (const name of createdDatabases) await admin.$executeRawUnsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    } finally { await admin.$disconnect(); }
  }
}
console.log(`\n${files.length - failures}/${files.length} test files passed (isolated ${postgres ? "PostgreSQL" : "PGlite"} databases; external providers disabled).`);
if (failedFiles.length) console.error(`Failed files:\n${failedFiles.join("\n")}`);
process.exitCode = failures ? 1 : 0;
