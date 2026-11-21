import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import {
  createWebAdapter,
  DEFAULT_PROVIDER,
  getProviderProfileDir,
  listActiveProviderIds,
  resolveProvider,
} from "../browser/provider-registry.js";
import { getAppDataDir } from "../platform/paths.js";

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

export function extractPromptFromPayload(payload) {
  if (Array.isArray(payload.messages) && payload.messages.length > 0) {
    return formatMessagesToPrompt(payload.messages);
  }
  if (typeof payload.input === "string") {
    return payload.input.trim();
  }
  if (Array.isArray(payload.input) && payload.input.length > 0) {
    return payload.input
      .map((item) => {
        if (typeof item === "string") return item;
        const role = item.role || "user";
        let content = "";
        if (typeof item.content === "string") {
          content = item.content;
        } else if (Array.isArray(item.content)) {
          content = item.content.map((c) => c.text || c.input_text || "").filter(Boolean).join(" ");
        }
        return `${role}: ${content}`;
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return "";
}

export function normalizeModelId(model, defaultProvider = DEFAULT_PROVIDER) {
  let raw = model || defaultProvider;
  if (typeof raw === "string") {
    if (raw.includes("/")) raw = raw.split("/").pop();
    if (raw.includes(":")) raw = raw.split(":").pop();
  }
  return raw;
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
      const appData = this.appDataDir ? path.resolve(this.appDataDir) : getAppDataDir();
      const profileDir = getProviderProfileDir(appData, provider.id);

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
    console.log(`[WTAgent API] ${req.method} ${pathname}`);

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
        const modelId = normalizeModelId(payload.model, defaultProvider);

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

    // Responses API (OpenAI Responses format used by newer AI SDKs)
    if (pathname === "/v1/responses" || pathname === "/responses" || pathname.endsWith("/responses")) {
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

        const prompt = extractPromptFromPayload(payload);
        if (!prompt) {
          sendError(res, 400, "Request contained no input text or messages");
          return;
        }

        const stream = Boolean(payload.stream);
        const modelId = normalizeModelId(payload.model, defaultProvider);

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

        const responseId = `resp_${crypto.randomUUID()}`;
        const itemId = `item_${crypto.randomUUID()}`;

        if (stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          });

          res.write(`event: response.output_item.added\ndata: ${JSON.stringify({
            type: "response.output_item.added",
            response_id: responseId,
            output_index: 0,
            item: {
              id: itemId,
              type: "message",
              role: "assistant",
              content: [],
            },
          })}\n\n`);

          res.write(`event: response.content_part.added\ndata: ${JSON.stringify({
            type: "response.content_part.added",
            response_id: responseId,
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            part: {
              type: "output_text",
              text: "",
            },
          })}\n\n`);

          let fullText = "";
          try {
            await adapter.sendMessage(prompt);
            await adapter.waitForTurnComplete({
              timeoutMs: 120_000,
              onDelta: (delta) => {
                if (!delta) return;
                fullText += delta;
                res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
                  type: "response.output_text.delta",
                  response_id: responseId,
                  item_id: itemId,
                  output_index: 0,
                  content_index: 0,
                  delta,
                })}\n\n`);
              },
            });

            res.write(`event: response.output_text.done\ndata: ${JSON.stringify({
              type: "response.output_text.done",
              response_id: responseId,
              item_id: itemId,
              output_index: 0,
              content_index: 0,
              text: fullText,
            })}\n\n`);

            res.write(`event: response.completed\ndata: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: responseId,
                status: "completed",
                model: provider.id,
                output: [
                  {
                    id: itemId,
                    type: "message",
                    role: "assistant",
                    content: [
                      {
                        type: "output_text",
                        text: fullText,
                      },
                    ],
                  },
                ],
              },
            })}\n\n`);
            res.end();
          } catch (err) {
            res.write(`event: error\ndata: ${JSON.stringify({
              error: { message: err.message, type: "turn_error" },
            })}\n\n`);
            res.end();
          }
        } else {
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
              id: responseId,
              object: "response",
              status: "completed",
              model: provider.id,
              output: [
                {
                  id: itemId,
                  type: "message",
                  role: "assistant",
                  content: [
                    {
                      type: "output_text",
                      text: replyText,
                    },
                  ],
                },
              ],
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
