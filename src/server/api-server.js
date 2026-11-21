import http from "node:http";
import crypto from "node:crypto";
import {
  createWebAdapter,
  DEFAULT_PROVIDER,
  listActiveProviderIds,
  resolveProvider,
} from "../browser/provider-registry.js";
import { getProfileDir } from "../platform/paths.js";

export function formatMessagesToPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "";
  }
  if (messages.length === 1) {
    return String(messages[0].content ?? "").trim();
  }
  return messages
    .map((msg) => {
      const role = String(msg.role || "user").toLowerCase();
      const prefix = role === "user" ? "User" : role === "system" ? "System" : "Assistant";
      return `${prefix}: ${String(msg.content ?? "").trim()}`;
    })
    .join("\n\n");
}

export class AdapterPool {
  constructor({
    chromePath,
    appDataDir,
    defaultProvider = DEFAULT_PROVIDER,
    debug = false,
    adapterFactory = createWebAdapter,
  } = {}) {
    this.chromePath = chromePath;
    this.appDataDir = appDataDir;
    this.defaultProvider = defaultProvider;
    this.debug = debug;
    this.adapterFactory = adapterFactory;
    this.adapters = new Map();
  }

  async getAdapter(providerId) {
    const provider = resolveProvider(providerId || this.defaultProvider);
    let entry = this.adapters.get(provider.id);
    if (!entry) {
      const profileDir = this.appDataDir
        ? getProfileDir(this.appDataDir, provider.profileBasename)
        : undefined;

      const adapter = this.adapterFactory({
        provider,
        profileDir,
        chromePath: this.chromePath,
        debug: this.debug,
      });
      await adapter.launch();
      await adapter.startConversation();
      entry = { adapter, provider };
      this.adapters.set(provider.id, entry);
    }
    return entry;
  }

  async closeAll() {
    for (const { adapter } of this.adapters.values()) {
      try {
        await adapter.close();
      } catch {
        // ignore close failures
      }
    }
    this.adapters.clear();
  }
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function sendJson(res, statusCode, data) {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message, code = "api_error") {
  sendJson(res, statusCode, {
    error: {
      message,
      type: "invalid_request_error",
      code,
    },
  });
}

export function createApiServer({
  port = 8080,
  host = "127.0.0.1",
  defaultProvider = DEFAULT_PROVIDER,
  adapterPool = null,
  chromePath = null,
  appDataDir = null,
} = {}) {
  const pool = adapterPool ?? new AdapterPool({ chromePath, appDataDir, defaultProvider });

  const server = http.createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";

    // Health check
    if (pathname === "/" || pathname === "/health") {
      sendJson(res, 200, {
        status: "ok",
        service: "wtagent-api-server",
        defaultModel: defaultProvider,
        models: listActiveProviderIds(),
      });
      return;
    }

    // List models (OpenAI compatible)
    if (pathname === "/v1/models" || pathname === "/models") {
      const activeIds = listActiveProviderIds();
      sendJson(res, 200, {
        object: "list",
        data: activeIds.map((id) => ({
          id,
          object: "model",
          created: 1700000000,
          owned_by: "wtagent",
        })),
      });
      return;
    }

    // Chat completions (OpenAI compatible)
    if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") {
      if (req.method !== "POST") {
        sendError(res, 405, "Method Not Allowed");
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });

      req.on("end", async () => {
        let payload;
        try {
          payload = JSON.parse(body || "{}");
        } catch {
          sendError(res, 400, "Invalid JSON in request body");
          return;
        }

        const messages = payload.messages;
        if (!Array.isArray(messages) || messages.length === 0) {
          sendError(res, 400, "Missing or invalid 'messages' array in request body");
          return;
        }

        const prompt = formatMessagesToPrompt(messages);
        if (!prompt) {
          sendError(res, 400, "Messages contained no text content");
          return;
        }

        const stream = Boolean(payload.stream);
        const modelId = payload.model || defaultProvider;

        let provider;
        let adapter;
        try {
          const entry = await pool.getAdapter(modelId);
          provider = entry.provider;
          adapter = entry.adapter;
        } catch (err) {
          sendError(res, 400, err.message, "model_error");
          return;
        }

        const completionId = `chatcmpl-${crypto.randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);

        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });

          try {
            await adapter.sendMessage(prompt);
            await adapter.waitForTurnComplete({
              timeoutMs: 120_000,
              onDelta: (delta) => {
                if (!delta) return;
                const chunk = {
                  id: completionId,
                  object: "chat.completion.chunk",
                  created,
                  model: provider.id,
                  choices: [
                    {
                      index: 0,
                      delta: { content: delta },
                      finish_reason: null,
                    },
                  ],
                };
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
              },
            });

            // Final stop chunk
            const finalChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: provider.id,
              choices: [
                {
                  index: 0,
                  delta: {},
                  finish_reason: "stop",
                },
              ],
            };
            res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          } catch (err) {
            const errorChunk = {
              error: {
                message: err.message,
                type: "turn_error",
              },
            };
            res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
            res.end();
          }
        } else {
          // Non-streaming
          try {
            await adapter.sendMessage(prompt);
            let fullText = "";
            const turnResult = await adapter.waitForTurnComplete({
              timeoutMs: 120_000,
              onDelta: (delta) => {
                fullText += delta;
              },
            });

            const replyText = turnResult?.text || fullText;

            sendJson(res, 200, {
              id: completionId,
              object: "chat.completion",
              created,
              model: provider.id,
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: replyText,
                  },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: prompt.length,
                completion_tokens: replyText.length,
                total_tokens: prompt.length + replyText.length,
              },
            });
          } catch (err) {
            sendError(res, 500, err.message, "turn_error");
          }
        }
      });
      return;
    }

    sendError(res, 404, `Not Found: ${pathname}`);
  });

  return {
    server,
    pool,
    listen: (customPort = port, customHost = host) =>
      new Promise((resolve, reject) => {
        server.listen(customPort, customHost, (err) => {
          if (err) reject(err);
          else resolve(server.address());
        });
      }),
    close: async () => {
      await pool.closeAll();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
