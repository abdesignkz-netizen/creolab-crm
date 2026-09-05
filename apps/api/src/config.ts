import dotenv from "dotenv";
import path from "node:path";

dotenv.config({ path: path.resolve(process.cwd(), ".env") });
dotenv.config({ path: path.resolve(process.cwd(), "packages/db/.env") });

export const config = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.API_PORT || 4100),
  appBaseUrl: process.env.APP_BASE_URL || "http://localhost:5173",
  apiBaseUrl: process.env.API_BASE_URL || "http://localhost:4100",
  allowedOrigins: String(
    process.env.ALLOWED_ORIGINS ||
      "http://localhost:4180,http://127.0.0.1:4180,http://localhost:5173,http://127.0.0.1:5173",
  )
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
  sessionSecret: process.env.SESSION_SECRET || "dev-session-secret-change",
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || "dev-access-secret-change",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || "dev-refresh-secret-change",
  cookieSecure: process.env.NODE_ENV === "production",
  whatsappSellerUrl: process.env.WHATSAPP_SELLER_URL || "",
  whatsappSellerSecret: process.env.WHATSAPP_SELLER_SECRET || "",
  crmBridgeSecret: process.env.CRM_BRIDGE_SECRET || "",
};

export const isDemoTestRuntime = config.nodeEnv !== "production";
