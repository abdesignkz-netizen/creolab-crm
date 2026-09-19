import dotenv from "dotenv";
import path from "node:path";

const envFiles = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "../../.env"),
  path.resolve(process.cwd(), "packages/db/.env"),
  path.resolve(process.cwd(), "../../packages/db/.env"),
];
for (const file of envFiles) {
  dotenv.config({ path: file });
}

function envSecret(name: string, fallback: string) {
  const value = process.env[name];
  if (value) return value;
  if (process.env.NODE_ENV === "production") {
    throw new Error(`${name} is required in production`);
  }
  return fallback;
}

function readAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (raw && raw.trim()) {
    const origins = raw.split(",").map((item) => item.trim()).filter(Boolean);
    if (process.env.NODE_ENV === "production" && origins.some((item) => item === "*")) {
      throw new Error("ALLOWED_ORIGINS must not include * in production");
    }
    return origins;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("ALLOWED_ORIGINS is required in production");
  }
  return [
    "http://localhost:4180",
    "http://127.0.0.1:4180",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ];
}

function readTrustProxy(): number | false {
  const raw = String(process.env.TRUST_PROXY || "").trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === "true") return 1;
  if (process.env.RENDER === "true" || process.env.RENDER_SERVICE_ID) return 1;
  return false;
}

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.API_PORT || process.env.PORT || 4100),
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:5173",
  apiBaseUrl: process.env.API_BASE_URL || "http://localhost:4100",
  allowedOrigins: readAllowedOrigins(),
  sessionSecret: envSecret("SESSION_SECRET", "dev-session-secret-change"),
  jwtAccessSecret: envSecret("JWT_ACCESS_SECRET", "dev-access-secret-change"),
  jwtRefreshSecret: envSecret("JWT_REFRESH_SECRET", "dev-refresh-secret-change"),
  cookieSecure: process.env.NODE_ENV === "production",
  trustProxy: readTrustProxy(),
  whatsappSellerUrl: process.env.AI_MANAGER_URL || process.env.WHATSAPP_SELLER_URL || "",
  whatsappSellerSecret: process.env.WHATSAPP_SELLER_SECRET || "",
  crmBridgeSecret: process.env.CRM_BRIDGE_SECRET || "",
  internalServiceSecret: process.env.INTERNAL_SERVICE_SECRET || "",
  storageDir: process.env.STORAGE_DIR || "",
};

export const isDemoTestRuntime = config.nodeEnv !== "production";
