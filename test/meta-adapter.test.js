import test from "node:test";
import assert from "node:assert/strict";
import { MetaWebAdapter, isConnectionLostError } from "../src/browser/meta-web-adapter.js";

class EmptyLocator {
  async count() { return 0; }
  first() { return this; }
  last() { return this; }
  nth() { return this; }
  filter() { return this; }
  async isVisible() { return false; }
  async isEnabled() { return true; }
  async innerText() { return ""; }
  async getAttribute() { return null; }
  locator() { return this; }
  getByRole() { return this; }
  async click() {}
}

class VisibleLocator extends EmptyLocator {
  async count() { return 1; }
  async isVisible() { return true; }
}

class MetaRow extends EmptyLocator {
  constructor({ role, text, id = null }) {
    super();
    this.role = role;
    this.text = text;
    this.rowId = id;
  }

  async innerText() { return this.text; }

  async getAttribute(name) {
    if (name === "data-testid") {
      return this.role === "user" ? "user-message" : "assistant-message";
    }
    if (name === "id") {
      return this.rowId;
    }
    return null;
  }

  locator(selector) {
    if (selector.includes("message-content") || selector.includes("markdown") || selector.includes("prose")) {
      const text = this.text;
      return {
        async count() { return 1; },
        last() { return { async innerText() { return text; } }; },
      };
    }
    return new EmptyLocator();
  }
}

class RowCollection extends EmptyLocator {
  constructor(rows) {
    super();
    this.rows = rows;
  }

  async count() { return this.rows.length; }
  nth(index) { return this.rows[index] ?? new EmptyLocator(); }
  last() { return this.rows.at(-1) ?? new EmptyLocator(); }
}

function createMetaPage(rows) {
  const assistant = rows.filter((row) => row.role === "assistant");
  const user = rows.filter((row) => row.role === "user");
  return {
    url() { return "https://www.meta.ai/c/abc-123"; },
    locator(selector) {
      if (selector.includes("assistant-message")) {
        return new RowCollection(assistant);
      }
      if (selector.includes("user-message")) {
        return new RowCollection(user);
      }
      return new RowCollection(rows);
    },
    getByRole() { return new EmptyLocator(); },
    async waitForTimeout() {},
  };
}

test("re-exports the shared connection-lost detector", () => {
  assert.equal(
    isConnectionLostError(new Error("Target page, context or browser has been closed")),
    true,
  );
  assert.equal(isConnectionLostError(new Error("unrelated error")), false);
});

test("exposes Meta AI base URL and conversation URL pattern", () => {
  const adapter = new MetaWebAdapter({ profileDir: "." });
  assert.equal(adapter.providerName, "Meta AI");
  assert.equal(adapter.baseUrl, "https://www.meta.ai/");
  assert.equal(adapter.conversationUrlPattern().test("/c/12345"), true);
  assert.equal(adapter.conversationUrlPattern().test("/t/67890"), true);
  assert.equal(adapter.conversationUrlPattern().test("/chat/xyz"), true);
  assert.equal(adapter.conversationUrlPattern().test("/thread/abc"), true);
  assert.equal(adapter.conversationUrlPattern().test("/"), false);
});

test("classifies fresh, restorable, and unknown URLs", () => {
  const adapter = new MetaWebAdapter({ profileDir: "." });
  assert.equal(adapter.classifyConversationUrl("https://www.meta.ai/"), "fresh");
  assert.equal(adapter.classifyConversationUrl("https://www.meta.ai/c/123"), "restorable");
  assert.equal(adapter.classifyConversationUrl("https://www.meta.ai/t/456"), "restorable");
  assert.equal(adapter.classifyConversationUrl("https://www.meta.ai/settings"), "unknown");
  assert.equal(adapter.classifyConversationUrl("https://other.com/c/123"), "invalid");
});

test("provides robust composer locators covering input and contenteditable", () => {
  const selectors = [];
  const locator = new EmptyLocator();
  const adapter = new MetaWebAdapter({ profileDir: "." });
  adapter.page = {
    locator(selector) {
      selectors.push(selector);
      return locator;
    },
  };

  adapter.composerLocators();
  assert.ok(selectors.some((s) => s.includes('input[aria-label="Ask Meta AI"]')));
  assert.ok(selectors.some((s) => s.includes('div[contenteditable="true"]')));
});

test("provides send, stop, and new chat controls", () => {
  const selectors = [];
  const roles = [];
  const locator = new EmptyLocator();
  const adapter = new MetaWebAdapter({ profileDir: "." });
  adapter.page = {
    locator(selector) {
      selectors.push(selector);
      return locator;
    },
    getByRole(role, opts) {
      roles.push({ role, ...opts });
      return locator;
    },
  };

  adapter.sendButtonLocators();
  adapter.stopButtonLocators();
  adapter.newConversationControls();

  assert.ok(selectors.some((s) => s.includes('button[aria-label="Send"]')));
  assert.ok(selectors.some((s) => s.includes('button[aria-label="Stop"]')));
  assert.ok(selectors.some((s) => s.includes('a[href="/"]')));
});

test("detects unauthenticated state from auth redirects and login controls", async () => {
  const adapter = new MetaWebAdapter({ profileDir: "." });
  adapter.page = {
    url() { return "https://auth.meta.com/?redirect_uri=https://www.meta.ai/"; },
    locator() { return new EmptyLocator(); },
    getByRole() { return new EmptyLocator(); },
  };

  assert.equal(await adapter.getAuthState(), "unauthenticated");

  adapter.page.url = () => "https://www.meta.ai/";
  const loginLocator = new EmptyLocator();
  loginLocator.count = async () => 1;
  loginLocator.isVisible = async () => true;

  adapter.page.locator = (selector) => (
    selector.includes("login-button") ? loginLocator : new EmptyLocator()
  );

  assert.equal(await adapter.getAuthState(), "unauthenticated");
});

test("detects blocked guest access when login or download modal is visible", async () => {
  const adapter = new MetaWebAdapter({ profileDir: "." });
  const card = new EmptyLocator();
  adapter.page = {
    locator(selector) {
      if (selector === '[data-testid="login-button"]') {
        return card;
      }
      return new EmptyLocator();
    },
  };

  assert.equal(await adapter.isGuestAccessBlocked(), false);
  card.count = async () => 1;
  card.isVisible = async () => true;
  assert.equal(await adapter.isGuestAccessBlocked(), true);
});

test("uses message id and role-scoped count as identity", async () => {
  const adapter = new MetaWebAdapter({ profileDir: "." });
  const rows = [
    new MetaRow({ role: "user", text: "hello", id: "u-1" }),
    new MetaRow({ role: "assistant", text: "world", id: "a-1" }),
  ];
  adapter.page = createMetaPage(rows);

  const userIdentity = await adapter.messageIdentity(rows[0]);
  assert.equal(userIdentity.id, "u-1");
  assert.equal(userIdentity.turn, 1);

  const assistantIdentity = await adapter.messageIdentity(rows[1]);
  assert.equal(assistantIdentity.id, "a-1");
  assert.equal(assistantIdentity.turn, 1);
});

test("isNewAssistantIdentity recognizes new turns and updated content", () => {
  const adapter = new MetaWebAdapter({ profileDir: "." });
  adapter.assistantCountBeforeSend = 1;
  adapter.lastAssistantMessageIdBeforeSend = "msg-1";
  adapter.lastAssistantTextBeforeSend = "old text";

  // New turn by count
  assert.equal(adapter.isNewAssistantIdentity({ id: "msg-1", turn: 2, text: "old text" }), true);
  // New turn by id
  assert.equal(adapter.isNewAssistantIdentity({ id: "msg-2", turn: 1, text: "old text" }), true);
  // New turn by changed text
  assert.equal(adapter.isNewAssistantIdentity({ id: "msg-1", turn: 1, text: "new text" }), true);
  // Stale
  assert.equal(adapter.isNewAssistantIdentity({ id: "msg-1", turn: 1, text: "old text" }), false);
});

test("assistantText and userMessageText normalize non-breaking spaces", async () => {
  const adapter = new MetaWebAdapter({ profileDir: "." });
  const assistantRow = new MetaRow({
    role: "assistant",
    text: '<tool_call\u00a0name="fs.read"><path>foo</path></tool_call>',
  });
  const userRow = new MetaRow({
    role: "user",
    text: 'hello\u00a0world',
  });

  assert.equal(
    await adapter.assistantText(assistantRow),
    '<tool_call name="fs.read"><path>foo</path></tool_call>',
  );
  assert.equal(
    await adapter.userMessageText(userRow),
    "hello world",
  );
});

test("uses stop button as generation signal and declares reliable completion", async () => {
  const adapter = new MetaWebAdapter({ profileDir: "." });
  const stopButton = new EmptyLocator();
  adapter.page = {
    locator(selector) {
      if (selector === 'button[aria-label="Stop"]') {
        return stopButton;
      }
      return new EmptyLocator();
    },
    getByRole() { return new EmptyLocator(); },
  };

  assert.equal(adapter.hasReliableCompletionSignal(), true);
  assert.equal(await adapter.isAssistantGenerating(), false);

  stopButton.count = async () => 1;
  stopButton.isVisible = async () => true;
  assert.equal(await adapter.isAssistantGenerating(), true);
});

test("detects usage limit and generation error notices with action controls", async () => {
  const adapter = new MetaWebAdapter({ profileDir: "." });
  const button = new VisibleLocator();

  const limitRow = new MetaRow({
    role: "assistant",
    text: "You have reached your limit. Please try again tomorrow.",
  });
  limitRow.getByRole = () => button;

  const errorRow = new MetaRow({
    role: "assistant",
    text: "Something went wrong while generating response.",
  });
  errorRow.getByRole = () => button;

  adapter.page = { getByRole: () => new EmptyLocator() };

  assert.ok(await adapter.findUsageLimitMarker(limitRow));
  assert.ok(await adapter.findGenerationErrorMarker(errorRow));
});

test("dismisses transient overlays if a close button is visible", async () => {
  const adapter = new MetaWebAdapter({ profileDir: "." });
  let clicked = false;
  const closeButton = new VisibleLocator();
  closeButton.click = async () => { clicked = true; };

  adapter.page = {
    locator(selector) {
      if (selector.includes('button[aria-label*="close" i]')) {
        return closeButton;
      }
      return new EmptyLocator();
    },
  };

  await adapter.dismissTransientOverlays();
  assert.equal(clicked, true);
});
