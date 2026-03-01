import { loadHubConfig } from "./config.js";
import { createHubRuntime } from "./hub.js";
import { HubLogger } from "./logger.js";

async function bootstrap(): Promise<void> {
  const config = await loadHubConfig();
  const logger = new HubLogger(config.logging.level);
  const runtime = await createHubRuntime(config);

  await runtime.app.listen({
    host: config.listen.host,
    port: config.listen.port
  });

  logger.info("hub.started", {
    host: config.listen.host,
    port: config.listen.port,
    domain: config.domain,
    ws: `wss://${config.domain}/ws`,
    http: `https://${config.domain}`,
    tokenConfigured: Boolean(config.security.token),
    validationMode: config.validation.mode,
    persistenceEnabled: config.persistence.enabled
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info("hub.shutdown", { signal });
    await runtime.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  process.stderr.write(JSON.stringify({ ts: Date.now(), level: "fatal", msg: "hub.start.failed", error: message }) + "\n");
  process.exit(1);
});
