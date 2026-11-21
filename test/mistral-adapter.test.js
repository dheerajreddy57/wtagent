import test from "node:test";
import assert from "node:assert/strict";
import { MistralWebAdapter, isConnectionLostError } from "../src/browser/mistral-web-adapter.js";

class EmptyLocator {
  async count() { return 0; }
  nth() { return this; }
  first() { return this; }
  last() { return this; }
  filter() { return this; }
  async isVisible() { return false; }
  async isEnabled() { return true; }
  async innerText() { return ""; }
  async getAttribute() { return null; }
  locator() { return this; }
  getByRole() { return new EmptyLocator(); }
}

class VisibleLocator extends EmptyLocator {
  async count() { return 1; }
  async isVisible() { return true; }
}

class MistralMessage extends EmptyLocator {
  constructor({ role, text, id, testId }) {
    super();
    this.role = role;
    this.text = text;
    this.idAttr = id;
    this.testIdAttr = testId;
  }

  async innerText() { return this.text; }

  async getAttribute(name) {
    if (name === "id") return this.idAttr ?? null;
    if (name === "data-testid") return this.testIdAttr ?? (this.role === "user" ? "user-message" : "assistant-message");
    if (name === "data-message-role") return this.role;
    return null;
  }

  locator(selector) {
    if (selector.includes("prose") || selector.includes("message-content")) {
      const text = this.text;
      return {
        async count() { return 1; },
        last() {
          return {
            async innerText() { return text; },
          };
        },
      };
    }
    return new EmptyLocator();
  }
}

class MessageCollection extends EmptyLocator {
  constructor(messages) {
    super();
    this.messages = messages;
  }
  async count() { return this.messages.length; }
  nth(index) { return this.messages[index] ?? new EmptyLocator(); }
  first() { return this.messages[0] ?? new EmptyLocator(); }
  last() { return this.messages.at(-1) ?? new EmptyLocator(); }
}

function createMistralPage({ url = "https://chat.mistral.ai/", messages = [], stopVisible = false } = {}) {
  const user = messages.filter((m) => m.role === "user");
  const assistant = messages.filter((m) => m.role === "assistant");
  return {
    url() { return url; },
    async title() { return "Mistral"; },
    locator(selector) {
      if (selector.includes('button[aria-label*="Stop" i]')) {
        return stopVisible ? new VisibleLocator() : new EmptyLocator();
      }
      if (selector.includes('[data-testid="user-message"]') && !selector.includes('[data-testid="assistant-message"]')) {
        return new MessageCollection(user);
      }
      if (selector.includes('[data-testid="assistant-message"]') && !selector.includes('[data-testid="user-message"]')) {
        return new MessageCollection(assistant);
      }
      if (selector.includes('[data-testid="user-message"]') && selector.includes('[data-testid="assistant-message"]')) {
        return new MessageCollection(messages);
      }
      return new EmptyLocator();
    },
    getByRole() { return new EmptyLocator(); },
    async waitForTimeout() {},
  };
}

test("re-exports connection loss detector", () => {
  assert.equal(isConnectionLostError(new Error("Target page, context or browser has been closed")), true);
  assert.equal(isConnectionLostError(new Error("other")), false);
});

test("exposes Mistral base URL and conversation URL classification", () => {
  const adapter = new MistralWebAdapter({ profileDir: "." });
  assert.equal(adapter.providerName, "Mistral");
  assert.equal(adapter.baseUrl, "https://chat.mistral.ai/");

  assert.ok(adapter.conversationUrlPattern().test("/chat/01928374-1234-abcd"));

  assert.equal(adapter.classifyConversationUrl("https://chat.mistral.ai/"), "fresh");
  assert.equal(adapter.classifyConversationUrl("https://chat.mistral.ai/chat"), "fresh");
  assert.equal(adapter.classifyConversationUrl("https://chat.mistral.ai/chat/01928374-1234-abcd"), "restorable");

  assert.equal(adapter.classifyConversationUrl("http://chat.mistral.ai/"), "invalid");
  assert.equal(adapter.classifyConversationUrl("https://other.ai/chat/123"), "invalid");
  assert.equal(adapter.classifyConversationUrl("not-valid"), "invalid");
});

test("detects Mistral auth redirect hostname", async () => {
  const adapter = new MistralWebAdapter({ profileDir: "." });
  adapter.page = createMistralPage({ url: "https://auth.mistral.ai/u/login" });
  assert.equal(await adapter.getAuthState(), "unauthenticated");
});

test("tracks Mistral message identities and normalizes whitespace", async () => {
  const adapter = new MistralWebAdapter({ profileDir: "." });
  const messages = [
    new MistralMessage({ role: "user", text: "Bonjour\u00a0Mistral", id: "m-user-1" }),
    new MistralMessage({ role: "assistant", text: "Bonjour\u00a0mon\u00a0ami!", id: "m-asst-1" }),
  ];
  adapter.page = createMistralPage({ messages });

  assert.equal(await adapter.userMessageText(messages[0]), "Bonjour Mistral");
  assert.equal(await adapter.assistantText(messages[1]), "Bonjour mon ami!");

  const userId = await adapter.messageIdentity(messages[0]);
  assert.equal(userId.id, "m-user-1");
  assert.equal(userId.turn, 1);

  const assistantId = await adapter.messageIdentity(messages[1]);
  assert.equal(assistantId.id, "m-asst-1");
  assert.equal(assistantId.turn, 1);
});

test("detects assistant generating state via stop button", async () => {
  const adapter = new MistralWebAdapter({ profileDir: "." });
  adapter.page = createMistralPage({ stopVisible: false });
  assert.equal(await adapter.isAssistantGenerating(), false);

  adapter.page = createMistralPage({ stopVisible: true });
  assert.equal(await adapter.isAssistantGenerating(), true);
});

test("declares reliable completion and dead request grace multiplier", () => {
  const adapter = new MistralWebAdapter({ profileDir: "." });
  assert.equal(adapter.hasReliableCompletionSignal(), true);
  assert.equal(adapter.deadRequestGraceMultiplier(), 3);
});
