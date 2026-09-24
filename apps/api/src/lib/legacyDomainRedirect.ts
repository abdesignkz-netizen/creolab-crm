import type { RequestHandler } from "express";

type DomainRedirectConfig = {
  appBaseUrl: string;
  legacyAppOrigin: string;
  legacyRedirectMode: string;
};

function httpsOrigin(value: string, name: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS origin without path, credentials, query or fragment`);
  }
  return url;
}

export function createLegacyDomainRedirect(settings: DomainRedirectConfig): RequestHandler {
  const mode = settings.legacyRedirectMode;
  if (mode === "off") return (_req, _res, next) => next();
  if (mode !== "ui" && mode !== "all") throw new Error("LEGACY_REDIRECT_MODE must be off, ui or all");
  const legacy = httpsOrigin(settings.legacyAppOrigin, "LEGACY_APP_ORIGIN");
  const target = httpsOrigin(settings.appBaseUrl, "APP_BASE_URL");
  if (legacy.origin === target.origin) throw new Error("Legacy and primary app origins must differ");

  return (req, res, next) => {
    // Match the actual Host, never Origin/X-Forwarded-Host or a wildcard domain.
    const host = (req.get("host") || "").toLowerCase().replace(/:443$/, "");
    if (host !== legacy.host) return next();
    // Health probes must work on both domains throughout the migration.
    if (/^\/(health|ready)(\/|$)/.test(req.path)) return next();
    if (mode === "ui") {
      // Keep signed POST bodies, callback query strings and old API clients intact.
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (/^\/(api|public|\.well-known)(\/|$)/i.test(req.path)) return next();
    }
    // Concatenation keeps the exact encoded path/query and cannot accept an external target.
    res.redirect(301, `${target.origin}${req.originalUrl}`);
  };
}
