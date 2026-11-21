import { BaseWebAdapter, firstVisible } from "./base-web-adapter.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";

export { isConnectionLostError } from "./base-web-adapter.js";

const MISTRAL_URL = "https://chat.mistral.ai/";

// Mistral Le Chat (chat.mistral.ai) adapter.
export class MistralWebAdapter extends BaseWebAdapter {
  constructor(options = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? MISTRAL_URL,
      providerName: "Mistral",
    });
  }

  conversationUrlPattern() {
    return /^\/chat\//;
  }

  classifyConversationUrl(value) {
    let parsed;
    try {
      parsed = value instanceof URL ? value : new URL(value);
    } catch {
      return "invalid";
    }
    if (parsed.protocol !== "https:") return "invalid";
    if (parsed.hostname !== "chat.mistral.ai") {
      return "invalid";
    }
    const pattern = this.conversationUrlPattern();
    if (pattern?.test(parsed.pathname)) {
      return "restorable";
    }
    const isFresh = parsed.pathname === "/" || parsed.pathname === "/chat";
    return isFresh ? "fresh" : "unknown";
  }

  composerLocators() {
    return [
      this.page.locator('textarea[placeholder*="Ask" i]').first(),
      this.page.locator('textarea[placeholder*="Type a message" i]').first(),
      this.page.locator('textarea[placeholder*="Message" i]').first(),
      this.page.locator('div[contenteditable="true"]').first(),
      this.page.locator("main textarea").first(),
      this.page.locator("textarea").first(),
    ];
  }

  sendButtonLocators() {
    return [
      this.page.locator('button[aria-label*="Send" i]'),
      this.page.locator('button[aria-label*="Submit" i]'),
      this.page.locator('button:has(svg)'),
      this.page.getByRole("button", { name: /^(send|submit|发送)$/i }),
    ];
  }

  stopButtonLocators() {
    return [
      this.page.locator('button[aria-label*="Stop" i]'),
      this.page.locator('button[title*="Stop" i]'),
      this.page.getByRole("button", { name: /^(stop|停止)$/i }),
    ];
  }

  newConversationControls() {
    return [
      this.page.locator('a[href="/chat"]'),
      this.page.locator('a[href="/"]'),
      this.page.locator('button[aria-label*="New chat" i]'),
      this.page.getByRole("button", { name: /^(new chat|新对话)$/i }),
      this.page.getByRole("link", { name: /^(new chat|新对话)$/i }),
    ];
  }

  loginControlLocators() {
    return [
      this.page.locator('a[href*="/auth"]'),
      this.page.locator('a[href*="/login"]'),
      this.page.getByRole("button", { name: /^(sign in|log in|登录|登入)$/i }),
      this.page.getByRole("link", { name: /^(sign in|log in|登录|登入)$/i }),
    ];
  }

  authUrlPattern() {
    return /^\/(?:auth|login|signin)(?:\/|$)/i;
  }

  authTextPattern() {
    return /sign in to mistral|continue with google|continue with microsoft|continue with email|log in|登录 Mistral/i;
  }

  async getAuthState() {
    this.requirePage();
    try {
      const url = new URL(this.page.url());
      if (/auth\.mistral\.ai/i.test(url.hostname)) {
        return "unauthenticated";
      }
    } catch {
      // Non-URL states fall through
    }
    return super.getAuthState();
  }

  assistantMessages() {
    return this.page.locator(
      '[data-testid="assistant-message"], [data-message-role="assistant"], div.prose',
    );
  }

  userMessages() {
    return this.page.locator(
      '[data-testid="user-message"], [data-message-role="user"]',
    );
  }

  conversationMessages() {
    return this.page.locator(
      '[data-testid="user-message"], [data-testid="assistant-message"], [data-message-role], div.prose',
    );
  }

  async messageIdentity(message) {
    const testId = await message.getAttribute("data-testid").catch(() => null);
    const role = await message.getAttribute("data-message-role").catch(() => null);
    const isUser = testId === "user-message" || role === "user";
    const scope = isUser ? this.userMessages() : this.assistantMessages();
    const id = await message.getAttribute("id").catch(() => null)
      ?? await message.getAttribute("data-message-id").catch(() => null);
    return {
      id: id || null,
      turn: await scope.count().catch(() => 0),
    };
  }

  isNewAssistantIdentity({ id, turn, text }) {
    if (id && this.lastAssistantMessageIdBeforeSend && id !== this.lastAssistantMessageIdBeforeSend) {
      return true;
    }
    if (turn != null && turn > (this.assistantCountBeforeSend ?? 0)) {
      return true;
    }
    const previous = String(this.lastAssistantTextBeforeSend ?? "");
    return Boolean(previous && String(text ?? "") !== previous);
  }

  async assistantText(message) {
    const textNode = message.locator('.prose, [data-testid="message-content"]');
    if (await textNode.count().catch(() => 0) > 0) {
      const text = await textNode.last().innerText().catch(() => "");
      if (text.trim()) {
        return text.replaceAll("\u00a0", " ");
      }
    }
    const text = await message.innerText().catch(() => "");
    return text.replaceAll("\u00a0", " ");
  }

  async userMessageText(message) {
    const text = await super.userMessageText(message);
    return text.replaceAll("\u00a0", " ");
  }

  hasReliableCompletionSignal() {
    return true;
  }

  async isAssistantGenerating() {
    return Boolean(await firstVisible(this.stopButtonLocators()));
  }

  async findUsageLimitMarker(message) {
    const text = await message.innerText().catch(() => "");
    if (!isUsageLimitNotice(text)) return null;
    const control = await firstVisible([
      message.getByRole("button", { name: /retry|try again|重试/i }),
      this.page.getByRole("button", { name: /retry|try again|重试/i }),
    ]);
    return control ? text.trim().slice(0, 120) : null;
  }

  deadRequestGraceMultiplier() {
    return 3;
  }
}
