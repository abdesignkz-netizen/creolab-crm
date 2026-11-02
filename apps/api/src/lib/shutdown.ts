import { logServerError } from "./redact.ts";

/** Leave time for the host's hard stop, without pretending a timed-out drain succeeded. */
export function installShutdownHandler(cleanup: () => Promise<void>) {
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      console.error("Shutdown deadline reached; unfinished durable work will be recovered after restart.");
      process.exit(1);
    }, 25_000);
    void Promise.resolve().then(cleanup).then(() => {
      clearTimeout(deadline); process.exit(0);
    }, error => {
      logServerError(error, "shutdown");
      clearTimeout(deadline); process.exit(1);
    });
  };
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, shutdown);
}
