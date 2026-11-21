import test from "node:test";
import assert from "node:assert/strict";
import {
  AdapterPool,
  AsyncMutex,
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
  async withAdapter(providerId, fn) {
    const entry = await this.getAdapter(providerId);
    return await fn(entry);
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

test("AsyncMutex serializes concurrent execution", async () => {
  const mutex = new AsyncMutex();
  const sequence = [];

  const task1 = mutex.runExclusive(async () => {
    sequence.push("start-1");
    await new Promise((r) => setTimeout(r, 20));
    sequence.push("end-1");
  });

  const task2 = mutex.runExclusive(async () => {
    sequence.push("start-2");
    await new Promise((r) => setTimeout(r, 10));
    sequence.push("end-2");
  });

  await Promise.all([task1, task2]);
  assert.deepEqual(sequence, ["start-1", "end-1", "start-2", "end-2"]);
});

test("AdapterPool deduplicates concurrent adapter initialization", async () => {
  let launchCount = 0;
  class SlowMockAdapter {
    async launch() {
      launchCount += 1;
      await new Promise((r) => setTimeout(r, 30));
    }
    async startConversation() {}
    async close() {}
  }

  const pool = new AdapterPool({
    adapterFactory: () => new SlowMockAdapter(),
  });

  // Call getAdapter concurrently for same model
  const [res1, res2, res3] = await Promise.all([
    pool.getAdapter("chatgpt"),
    pool.getAdapter("chatgpt"),
    pool.getAdapter("chatgpt"),
  ]);

  assert.equal(launchCount, 1, "Only a single adapter should be launched despite concurrent requests");
  assert.equal(res1.adapter, res2.adapter);
  assert.equal(res2.adapter, res3.adapter);
  await pool.closeAll();
});

test("AdapterPool cleans up promise and closes adapter if launch or startConversation fails", async () => {
  let fail = true;
  let closedCount = 0;
  class FailingMockAdapter {
    async launch() {}
    async startConversation() {
      if (fail) throw new Error("Connection failed");
    }
    async close() {
      closedCount += 1;
    }
  }

  const pool = new AdapterPool({
    adapterFactory: () => new FailingMockAdapter(),
  });

  await assert.rejects(
    () => pool.getAdapter("chatgpt"),
    /Connection failed/,
  );
  assert.equal(closedCount, 1, "Adapter should be closed on failure");

  // Subsequent call after fix should succeed
  fail = false;
  const res = await pool.getAdapter("chatgpt");
  assert.ok(res.adapter);
  await pool.closeAll();
});

test("AdapterPool provides helpful error message if provider is unauthenticated", async () => {
  class UnauthMockAdapter {
    async launch() {}
    async startConversation() {}
    async getAuthState() {
      return "unauthenticated";
    }
    async close() {}
  }

  const pool = new AdapterPool({
    adapterFactory: () => new UnauthMockAdapter(),
  });

  await assert.rejects(
    () => pool.getAdapter("deepseek"),
    /DeepSeek is currently not logged in.*wtagent login --model deepseek/,
  );
  await pool.closeAll();
});
