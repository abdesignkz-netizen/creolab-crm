import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

const denied = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) denied.addSubnet(address, prefix, "ipv4");
// Permit only global unicast IPv6, excluding transition and documentation ranges.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  denied.addSubnet(address, prefix, "ipv6");
}

export function isPublicMediaAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !denied.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !denied.check(address, "ipv6");
}

export function publicMediaUrl(raw: string) {
  const url = new URL(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || hostname === "localhost" || hostname.endsWith(".localhost")
    || (isIP(hostname) && !isPublicMediaAddress(hostname))) throw new Error("media_url_forbidden");
  return url;
}

/** Pin the validated DNS answer to the socket; validate every redirect afresh. */
export async function downloadPublicMedia(raw: string, maxBytes: number, redirects = 0, signal = AbortSignal.timeout(20_000)):
Promise<{ buffer: Buffer; contentType: string }> {
  const url = publicMediaUrl(raw);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !isPublicMediaAddress(address))) throw new Error("media_url_forbidden");
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(url, {
      agent: false, family: pinned.family, signal,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    }, response => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        response.destroy();
        if (redirects >= 3) return reject(new Error("media_redirect_limit"));
        try {
          resolve(downloadPublicMedia(new URL(response.headers.location, url).href, maxBytes, redirects + 1, signal));
        } catch (error) { reject(error); }
        return;
      }
      if (status < 200 || status >= 300 || Number(response.headers["content-length"]) > maxBytes) {
        response.destroy();
        reject(new Error(status >= 200 && status < 300 ? "media_too_large" : `media_http_${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy(new Error("media_too_large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => size
        ? resolve({ buffer: Buffer.concat(chunks), contentType: response.headers["content-type"] || "" })
        : reject(new Error("empty_media")));
    });
    req.on("error", reject);
    req.end();
  });
}
