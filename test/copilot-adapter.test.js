import test from "node:test";
import assert from "node:assert/strict";
import { CopilotWebAdapter, isConnectionLostError } from "../src/browser/copilot-web-adapter.js";

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

class CopilotMessage extends EmptyLocator {
  constructor({ role, text, id, testId, content }) {
    super();
    this.role = role;
    this.text = text;
    this.idAttr = id;
    this.testIdAttr = testId;
    this.contentAttr = content;
  }

  async innerText() { return this.text; }

  async getAttribute(name) {
    if (name === "id") return this.idAttr ?? null;
    if (name === "data-testid") return this.testIdAttr ?? (this.role === "user" ? "user-message" : "assistant-message");
    if (name === "data-content") return this.contentAttr ?? (this.role === "user" ? "user-message" : "ai-message");
    return null;
  }

  locator(selector) {
    if (selector.includes("ac-text-block") || selector.includes("message-content") || selector.includes("prose")) {
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

function createCopilotPage({ url = "https://copilot.microsoft.com/", messages = [], stopVisible = false } = {}) {
  const user = messages.filter((m) => m.role === "user");
  const assistant = messages.filter((m) => m.role === "assistant");
  return {
    url() { return url; },
    async title() { return "Copilot"; },
    locator(selector) {
      if (selector.includes('button[aria-label*="Stop" i]')) {
        return stopVisible ? new VisibleLocator() : new EmptyLocator();
      }
      if (selector.includes('[data-content="user-message"]') && !selector.includes('[data-content="ai-message"]')) {
        return new MessageCollection(user);
      }
      if (selector.includes('[data-content="ai-message"]') && !selector.includes('[data-content="user-message"]')) {
        return new MessageCollection(assistant);
      }
      if (selector.includes('[data-content="user-message"]') && selector.includes('[data-content="ai-message"]')) {
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
  assert.equal(isConnectionLostError(new Error("something else")), false);
});

test("exposes Copilot base URL and multi-domain conversation URL classification", () => {
  const adapter = new CopilotWebAdapter({ profileDir: "." });
  assert.equal(adapter.providerName, "Copilot");
  assert.equal(adapter.baseUrl, "https://copilot.microsoft.com/");

  // Pattern tests
  assert.ok(adapter.conversationUrlPattern().test("/chats/abc-123"));
  assert.ok(adapter.conversationUrlPattern().test("/c/abc-123"));
  assert.ok(adapter.conversationUrlPattern().test("/thread/abc-123"));
  assert.ok(adapter.conversationUrlPattern().test("/t/abc-123"));

  // Domain classification
  assert.equal(adapter.classifyConversationUrl("https://copilot.microsoft.com/"), "fresh");
  assert.equal(adapter.classifyConversationUrl("https://copilot.microsoft.com/chats"), "fresh");
  assert.equal(adapter.classifyConversationUrl("https://copilot.microsoft.com/chats/456"), "restorable");
  assert.equal(adapter.classifyConversationUrl("https://copilot.com/"), "fresh");
  assert.equal(adapter.classifyConversationUrl("https://copilot.com/chats/abc"), "restorable");
  assert.equal(adapter.classifyConversationUrl("https://copilot.cloud.microsoft/c/123"), "restorable");

  // Invalid cases
  assert.equal(adapter.classifyConversationUrl("http://copilot.microsoft.com/"), "invalid");
  assert.equal(adapter.classifyConversationUrl("https://evil.com/chats/123"), "invalid");
  assert.equal(adapter.classifyConversationUrl("not-a-url"), "invalid");
});

test("detects Microsoft authentication redirects", async () => {
  const adapter = new CopilotWebAdapter({ profileDir: "." });
  adapter.page = createCopilotPage({ url: "https://login.live.com/oauth20_authorize.srf" });
  assert.equal(await adapter.getAuthState(), "unauthenticated");

  adapter.page = createCopilotPage({ url: "https://login.microsoftonline.com/common/oauth2" });
  assert.equal(await adapter.getAuthState(), "unauthenticated");

  adapter.page = createCopilotPage({ url: "https://account.microsoft.com/signin" });
  assert.equal(await adapter.getAuthState(), "unauthenticated");
});

test("normalizes non-breaking spaces and tracks message identities", async () => {
  const adapter = new CopilotWebAdapter({ profileDir: "." });
  const messages = [
    new CopilotMessage({ role: "user", text: "Hello\u00a0Copilot", id: "msg-1" }),
    new CopilotMessage({ role: "assistant", text: "Hello\u00a0there\u00a0human!", id: "msg-2" }),
  ];
  adapter.page = createCopilotPage({ messages });

  assert.equal(await adapter.userMessageText(messages[0]), "Hello Copilot");
  assert.equal(await adapter.assistantText(messages[1]), "Hello there human!");

  const userId = await adapter.messageIdentity(messages[0]);
  assert.equal(userId.id, "msg-1");
  assert.equal(userId.turn, 1);

  const assistantId = await adapter.messageIdentity(messages[1]);
  assert.equal(assistantId.id, "msg-2");
  assert.equal(assistantId.turn, 1);
});

test("detects assistant generating state via stop button", async () => {
  const adapter = new CopilotWebAdapter({ profileDir: "." });
  adapter.page = createCopilotPage({ stopVisible: false });
  assert.equal(await adapter.isAssistantGenerating(), false);

  adapter.page = createCopilotPage({ stopVisible: true });
  assert.equal(await adapter.isAssistantGenerating(), true);
});

test("declares reliable completion and dead request grace multiplier", () => {
  const adapter = new CopilotWebAdapter({ profileDir: "." });
  assert.equal(adapter.hasReliableCompletionSignal(), true);
  assert.equal(adapter.deadRequestGraceMultiplier(), 3);
});
