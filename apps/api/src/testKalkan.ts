import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Test double only: verifies synthetic RSA CMS against actual bytes using OpenSSL.
 * Authority status is simulated; this does not test NCA trust or GOST cryptography.
 */
export async function startTestKalkan() {
  const previousUrl = process.env.KALKAN_VERIFY_URL;
  const server = createServer(async (req, res) => {
    const dir = await mkdtemp(path.join(tmpdir(), "test-cms-"));
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      await writeFile(path.join(dir, "signature.der"), Buffer.from(body.cmsBase64, "base64"));
      await writeFile(path.join(dir, "document"), Buffer.from(body.documentBase64, "base64"));
      await promisify(execFile)("openssl", ["cms", "-verify", "-noverify", "-binary", "-inform", "DER",
        "-in", path.join(dir, "signature.der"), "-content", path.join(dir, "document"), "-out", path.join(dir, "verified")]);
      res.end(JSON.stringify({ ok: true, cryptoStatus: "VERIFIED", authorityStatus: "VALID" }));
    } catch {
      res.end(JSON.stringify({ ok: false, cryptoStatus: "FAILED", authorityStatus: "UNCHECKED", error: "cms_verify_failed" }));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test verifier address");
  const url = `http://127.0.0.1:${address.port}`;
  process.env.KALKAN_VERIFY_URL = url;
  return { url, async close() {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    if (previousUrl === undefined) delete process.env.KALKAN_VERIFY_URL;
    else process.env.KALKAN_VERIFY_URL = previousUrl;
  } };
}
