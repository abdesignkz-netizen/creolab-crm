import type { RequestHandler } from "express";
import { ApiError } from "../errors.ts";
import { config } from "../config.ts";

function originOf(value: string) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch { return null; }
}

/** Browser origins are exact trusted origins, never a suffix match or the Host header. */
export const protectBrowserMutation: RequestHandler = (req, _res, next) => {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method) || !req.path.startsWith("/api/")) return next();
  const origin = req.get("origin");
  const referer = req.get("referer");
  const source = origin !== undefined ? originOf(origin) : referer ? originOf(referer) : undefined;
  const allowed = new Set([...config.allowedOrigins, config.appBaseUrl, config.apiBaseUrl].map(originOf).filter(Boolean));
  if ((source !== undefined && (!source || !allowed.has(source)))
    || (source === undefined && ["cross-site", "same-site"].includes(req.get("sec-fetch-site") || ""))) {
    return next(new ApiError(403, "untrusted_origin", "Запрос с этого сайта запрещён"));
  }
  // Native clients and authenticated server webhooks do not send browser metadata.
  next();
};

export const securityHeaders: RequestHandler = (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  const apiOrigin = originOf(config.apiBaseUrl);
  const connect = ["'self'", "wss://127.0.0.1:13579", ...(apiOrigin ? [apiOrigin] : [])];
  if (config.nodeEnv !== "production") connect.push("ws://localhost:*", "ws://127.0.0.1:*");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:", "font-src 'self' data:", "media-src 'self' blob:",
    `connect-src ${connect.join(" ")}`, "worker-src 'self' blob:", "object-src 'self' blob:",
    "frame-src 'self' blob:", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
  ].join("; "));
  if (config.nodeEnv === "production") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (/^\/(api|public|sign|verify)(\/|$)/.test(req.path)) {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  }
  next();
};
