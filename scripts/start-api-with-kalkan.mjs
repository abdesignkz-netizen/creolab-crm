import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function kalkanRuntime(env) {
  const url = (env.KALKAN_VERIFY_URL || "").trim().replace(/\/$/, "");
  const port = String(env.KALKAN_VERIFY_PORT || "4170");
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid KALKAN_VERIFY_PORT");
  const localUrl = `http://127.0.0.1:${port}`;
  // Preserve an explicitly configured remote verifier. Never start a competing local service.
  if (url && url !== localUrl && url !== `http://localhost:${port}`) return { embedded: false, env };
  const libDir = env.KALKAN_LIB_DIR || "/var/data/kalkan/lib";
  const jars = await readdir(libDir).catch(() => []);
  if (!jars.some(name => name.endsWith(".jar"))) {
    if (url) throw new Error("Local Kalkan configured but no SDK jars found in KALKAN_LIB_DIR");
    // Existing CRM installations without signing must remain available.
    console.warn("[kalkan] SDK not installed; contract signing unavailable. Install official SDK in KALKAN_LIB_DIR.");
    return { embedded: false, env };
  }
  return {
    embedded: true,
    url: localUrl,
    env: { ...env, KALKAN_LIB_DIR: libDir, KALKAN_VERIFY_PORT: port, KALKAN_VERIFY_URL: localUrl, KALKAN_OCSP: env.KALKAN_OCSP || "1" },
  };
}

export async function startApi({ env = process.env, apiCommand = process.execPath,
  apiArgs = ["--experimental-strip-types", resolve(root, "apps/api/src/index.ts")],
  javaCommand = "java", classesDir = resolve(root, "apps/api/kalkan-verify/build") } = {}) {
  const runtime = await kalkanRuntime(env);
  const children = new Set();
  let stopping = false;
  let forceTimer;
  let exitCode = 0;
  let finish;
  const done = new Promise(resolveDone => { finish = resolveDone; });
  const stop = (code = 0) => {
    if (stopping) return;
    stopping = true;
    exitCode = code;
    for (const child of children) child.kill("SIGTERM");
    forceTimer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 5000);
    forceTimer.unref();
    if (!children.size) finish(exitCode);
  };
  const start = (command, args, cwd) => {
    const child = spawn(command, args, { cwd, env: runtime.env, stdio: "inherit" });
    children.add(child);
    child.on("error", () => { console.error("[runtime] Child process could not start"); stop(1); });
    child.on("close", () => {
      children.delete(child);
      if (!stopping) { console.error("[runtime] Required child process stopped"); stop(1); }
      if (!children.size) finish(exitCode);
    });
    return child;
  };
  const onSignal = () => stop(0);
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    if (runtime.embedded) {
      start(javaCommand, ["-cp", classesDir, "VerifyServer"], root);
      let ready = false;
      for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
        try {
          const response = await fetch(`${runtime.url}/health`, { signal: AbortSignal.timeout(1000) });
          const body = await response.json();
          if (response.ok && body.status === "ready" && body.authorityCheckEnabled === true) { ready = true; break; }
        } catch { /* JVM startup is asynchronous. */ }
        await new Promise(resolveWait => setTimeout(resolveWait, 250));
      }
      if (!ready) { console.error("[kalkan] Startup failed: check SDK jars, CA certificates, port and KALKAN_OCSP"); stop(1); }
      else console.log("[kalkan] SDK ready; certificate revocation checks enabled");
    }
    if (!stopping) start(apiCommand, apiArgs, resolve(root, "apps/api"));
    return await done;
  } finally {
    clearTimeout(forceTimer);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startApi().then(code => { process.exitCode = code; }).catch(error => {
    console.error("[runtime]", error.message);
    process.exitCode = 1;
  });
}
