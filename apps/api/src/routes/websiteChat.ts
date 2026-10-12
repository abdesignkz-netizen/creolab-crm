import express from "express";
import type { PrismaClient } from "@creolab/db";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { clientIp, rateLimit } from "../lib/rateLimit.ts";
import { websiteChatOrigin, publicChatSettings, openWebsiteChatSession, readWebsiteChat, receiveWebsiteChat } from "../services/websiteChatService.ts";

/** Registered before the app's cookie-based CORS layer. This router never uses CRM authentication. */
export function websiteChatRouter(prisma: PrismaClient) {
  const router = express.Router();
  router.get("/widget.js", (_req, res) => res.type("application/javascript").sendFile(fileURLToPath(new URL("../public/chat-widget.js", import.meta.url))));
  router.use("/:key", async (req, res, next) => {
    rateLimit(`widget:ip:${clientIp(req)}`, 300);
    const row = await websiteChatOrigin(prisma, req.params.key, req.get("origin") || "");
    res.setHeader("Access-Control-Allow-Origin", req.get("origin")!);
    res.vary("Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") { res.sendStatus(204); return; }
    res.locals.widget = row;
    next();
  });
  router.use(express.json({ limit: "12kb" }));
  const bearer = (req: express.Request) => (req.get("authorization") || "").replace(/^Bearer /, "");
  router.get("/:key/config", (_req, res) => res.json(publicChatSettings(res.locals.widget)));
  router.post("/:key/session", async (req, res) => {
    rateLimit(`widget:session:ip:${clientIp(req)}`, 10);
    rateLimit(`widget:session:tenant:${res.locals.widget.tenantId}`, 200, 3600000);
    res.json(await openWebsiteChatSession(prisma, req.params.key, req.get("origin")!, bearer(req)));
  });
  router.get("/:key/messages", async (req, res) => {
    rateLimit(`widget:poll:${createHash("sha256").update(bearer(req)).digest("hex")}`, 60);
    res.json(await readWebsiteChat(prisma, req.params.key, req.get("origin")!, bearer(req)));
  });
  router.post("/:key/messages", async (req, res) => {
    rateLimit(`widget:messages:ip:${clientIp(req)}`, 30);
    rateLimit(`widget:messages:tenant:${res.locals.widget.tenantId}`, 300);
    res.json(await receiveWebsiteChat(prisma, req.params.key, req.get("origin")!, bearer(req), req.body));
  });
  return router;
}
