import { loadConfig, loadDotenv } from "./config.js";
import { createLogger } from "./log.js";
import { App } from "./app.js";

loadDotenv();
let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
const log = createLogger(config.LOG_LEVEL);
const app = new App(config, log);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("shutdown requested", { signal });
  const force = setTimeout(() => {
    log.error("shutdown timed out; exiting");
    process.exit(1);
  }, 10_000);
  force.unref();
  try {
    await app.stop();
    process.exit(0);
  } catch (err) {
    log.error("error during shutdown", { error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => log.error("unhandled rejection", { error: String(reason) }));
process.on("uncaughtException", (err) => {
  log.error("uncaught exception", { error: err.message });
  void shutdown("uncaughtException");
});

app.start().catch((err) => {
  log.error("startup failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
