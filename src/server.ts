import express from "express";
import { config } from "./config";
import { log } from "./logger";
import { handleVerification, verifySignature, parseIncoming } from "./whatsapp";
import { handleIncomingMessage } from "./orchestrator";

export function createServer() {
  const app = express();

  app.use(
    express.json({
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  app.get("/webhook", (req, res) => {
    const challenge = handleVerification(req.query as Record<string, unknown>);
    if (challenge !== null) {
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  });

  app.post("/webhook", (req, res) => {
    const signature = req.header("X-Hub-Signature-256");
    const rawBody = (req as any).rawBody as Buffer;

    if (!verifySignature(rawBody, signature)) {
      log("webhook_signature_invalid", {});
      res.sendStatus(401);
      return;
    }

    // Ack immediately - Meta expects a fast 200 and will retry/disable the webhook otherwise.
    // The actual work (spawning Claude Code) can take minutes, so it runs after we respond.
    res.sendStatus(200);

    const messages = parseIncoming(req.body);
    for (const msg of messages) {
      handleIncomingMessage(msg.from, msg.text, msg.id).catch((err) => {
        log("handle_message_failed", { from: msg.from, error: String(err) });
      });
    }
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  return app;
}

export function startServer() {
  const app = createServer();
  app.listen(config.server.port, () => {
    log("server_started", { port: config.server.port });
  });
}
