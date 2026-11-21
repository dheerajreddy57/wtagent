import test from "node:test";
import assert from "node:assert/strict";
import {
  createApiServer,
  extractPromptFromPayload,
  formatMessagesToPrompt,
  normalizeModelId,
} from "../src/server/api-server.js";

test("extractPromptFromPayload extracts text from string or arrays", () => {
  assert.equal(extractPromptFromPayload({ input: "simple query" }), "simple query");
  assert.equal(
    extractPromptFromPayload({
      input: [{ role: "user", content: [{ type: "input_text", text: "what is node?" }] }],
    }),
    "user: what is node?",
  );
  assert.equal(normalizeModelId("wtagent/chatgpt"), "chatgpt");
  assert.equal(normalizeModelId("custom:claude"), "claude");
});

test("formatMessagesToPrompt formats single and multiple messages", () => {
  assert.equal(formatMessagesToPrompt([]), "");
  assert.equal(
    formatMessagesToPrompt([{ role: "user", content: "hello" }]),
    "hello",
  );
  assert.equal(
    formatMessagesToPrompt([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "Tell me a joke" },
    ]),
    "System: You are a helpful assistant.\n\nUser: Hi\n\nAssistant: Hello!\n\nUser: Tell me a joke",
  );
});

class MockAdapter {
  constructor(reply = "Hello from WTAgent mock adapter!") {
    this.reply = reply;
    this.sentText = null;
  }
  async launch() {}
  async startConversation() {}
  async sendMessage(text) {
    this.sentText = text;
  }
  async waitForTurnComplete({ onDelta } = {}) {
    if (onDelta) {
      onDelta("Hello ");
      onDelta("from ");
      onDelta("WTAgent!");
    }
    return { text: this.reply };
  }
  async close() {}
}

class MockAdapterPool {
  constructor() {
    this.adapter = new MockAdapter();
  }
  async getAdapter(providerId) {
    if (providerId === "unknown-model") {
      throw new Error('Unknown model "unknown-model".');
    }
    return {
      adapter: this.adapter,
      provider: { id: providerId || "chatgpt", label: "ChatGPT" },
    };
  }
  async closeAll() {}
}

test("API server responds to health check and models list", async (t) => {
  const pool = new MockAdapterPool();
  const api = createApiServer({ adapterPool: pool });
  const addr = await api.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  t.after(() => api.close());

  // Health
  const healthRes = await fetch(`${baseUrl}/health`);
  assert.equal(healthRes.status, 200);
  const healthData = await healthRes.json();
  assert.equal(healthData.status, "ok");
  assert.equal(healthData.service, "wtagent-api-server");
  assert.ok(Array.isArray(healthData.models));

  // Models (OpenAI format)
  const modelsRes = await fetch(`${baseUrl}/v1/models`);
  assert.equal(modelsRes.status, 200);
  const modelsData = await modelsRes.json();
  assert.equal(modelsData.object, "list");
  assert.ok(modelsData.data.some((m) => m.id === "chatgpt"));
});

test("API server handles non-streaming chat completions", async (t) => {
  const pool = new MockAdapterPool();
  const api = createApiServer({ adapterPool: pool });
  const addr = await api.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  t.after(() => api.close());

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt",
      messages: [{ role: "user", content: "Tell me a joke" }],
      stream: false,
    }),
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.object, "chat.completion");
  assert.equal(data.model, "chatgpt");
  assert.ok(data.choices[0].message.content.includes("Hello from WTAgent"));
  assert.equal(data.choices[0].finish_reason, "stop");
  assert.equal(pool.adapter.sentText, "Tell me a joke");
});

test("API server handles streaming chat completions (SSE)", async (t) => {
  const pool = new MockAdapterPool();
  const api = createApiServer({ adapterPool: pool });
  const addr = await api.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  t.after(() => api.close());

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "chatgpt",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    }),
  });

  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type").includes("text/event-stream"));
  const text = await res.text();
  assert.ok(text.includes('data: {"id":"chatcmpl-'));
  assert.ok(text.includes('"delta":{"content":"Hello "}'));
  assert.ok(text.includes('"delta":{"content":"WTAgent!"}'));
  assert.ok(text.includes("data: [DONE]"));
});

test("API server handles /v1/responses endpoint", async (t) => {
  const pool = new MockAdapterPool();
  const api = createApiServer({ adapterPool: pool });
  const addr = await api.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  t.after(() => api.close());

  // Non-streaming
  const res = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "wtagent/chatgpt",
      input: "hi there",
      stream: false,
    }),
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.object, "response");
  assert.equal(data.status, "completed");
  assert.equal(data.output[0].content[0].text, "Hello from WTAgent mock adapter!");

  // Streaming
  const streamRes = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "wtagent/chatgpt",
      input: "hi there",
      stream: true,
    }),
  });
  assert.equal(streamRes.status, 200);
  const streamText = await streamRes.text();
  assert.ok(streamText.includes("event: response.output_item.added"));
  assert.ok(streamText.includes("event: response.output_text.delta"));
  assert.ok(streamText.includes("event: response.completed"));
});

test("API server validates input and returns appropriate errors", async (t) => {
  const pool = new MockAdapterPool();
  const api = createApiServer({ adapterPool: pool });
  const addr = await api.listen(0, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  t.after(() => api.close());

  // Bad JSON
  const badJsonRes = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "invalid-json",
  });
  assert.equal(badJsonRes.status, 400);

  // Missing messages
  const noMsgRes = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "chatgpt" }),
  });
  assert.equal(noMsgRes.status, 400);

  // Unknown model
  const unknownModelRes = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "unknown-model", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(unknownModelRes.status, 400);

  // Unknown route
  const notFoundRes = await fetch(`${baseUrl}/unknown/route`);
  assert.equal(notFoundRes.status, 404);

  // OPTIONS preflight
  const optionsRes = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "OPTIONS",
  });
  assert.equal(optionsRes.status, 204);
  assert.equal(optionsRes.headers.get("access-control-allow-origin"), "*");
});
