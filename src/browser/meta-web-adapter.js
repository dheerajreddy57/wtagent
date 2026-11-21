import { BaseWebAdapter, firstVisible } from "./base-web-adapter.js";
import { isUsageLimitNotice } from "../shared/usage-limit.js";

export { isConnectionLostError } from "./base-web-adapter.js";

const META_URL = "https://www.meta.ai/";

// Meta AI (meta.ai) adapter.
//
// Meta AI's web client (React / Tailwind):
//   - URL pattern: /c/<id>, /t/<id>, /chat/<id>, /thread/<id>
//   - Landing page has an input composer; authenticated threads use contenteditable / textarea
//   - Labeled Send / Stop buttons
//   - Dedicated Chrome profile under meta-profile
export class MetaWebAdapter extends BaseWebAdapter {
  constructor(options = {}) {
    super({
      ...options,
      baseUrl: options.baseUrl ?? META_URL,
      providerName: "Meta AI",
    });
  }

  conversationUrlPattern() {
    return /^\/(?:c|t|chat|thread)\//;
  }

  composerLocators() {
    return [
      this.page.locator('[data-slot="logged-out-composer-input"] input').first(),
      this.page.locator('input[aria-label="Ask Meta AI"]').first(),
      this.page.locator('main textarea, main [role="textbox"], main input[type="text"]').first(),
      this.page.locator('div[contenteditable="true"]').first(),
      this.page.locator('textarea[placeholder*="Ask Meta AI" i]').first(),
      this.page.locator('[role="textbox"]').first(),
      this.page.locator("textarea").first(),
    ];
  }

  sendButtonLocators() {
    return [
      this.page.locator('button[aria-label="Send"]'),
      this.page.locator('button[aria-label*="Send" i]'),
      this.page.locator('button[data-testid="composer-send-button"]'),
      this.page.getByRole("button", { name: /^(send|发送)$/i }),
    ];
  }

  stopButtonLocators() {
    return [
      this.page.locator('button[aria-label="Stop"]'),
      this.page.locator('button[aria-label*="Stop" i]'),
      this.page.locator('button[data-testid="composer-stop-button"]'),
      this.page.getByRole("button", { name: /^(stop|停止)$/i }),
    ];
  }

  newConversationControls() {
    return [
      this.page.locator('a[href="/"]'),
      this.page.locator('button[aria-label="New chat"]'),
      this.page.locator('button[aria-label*="New chat" i]'),
      this.page.locator('button[data-testid="new-chat"]'),
      this.page.getByRole("button", { name: /^(new chat|新对话)$/i }),
      this.page.getByRole("link", { name: /^(new chat|新对话)$/i }),
    ];
  }

  loginControlLocators() {
    return [
      this.page.locator('[data-testid="login-button"]'),
      this.page.getByRole("button", {
        name: /^(log in|sign in|登录|登入|ログイン|로그인)$/i,
      }),
      this.page.getByRole("link", {
        name: /^(log in|sign in|登录|登入|ログイン|로그인)$/i,
      }),
      this.page.locator('a[href*="/login"], a[href*="auth.meta.com"]'),
    ];
  }

  authUrlPattern() {
    return /^\/(?:login|signin|auth|oauth)(?:\/|$)/i;
  }

  authTextPattern() {
    return /log in to meta|sign in to meta|continue with facebook|continue with instagram|continue with email|download app/i;
  }

  async getAuthState() {
    this.requirePage();
    try {
      const url = new URL(this.page.url());
      if (/auth\.meta\.com|facebook\.com|instagram\.com/i.test(url.hostname)) {
        return "unauthenticated";
      }
    } catch {
      // Non-URL states fall through to base checks
    }
    return super.getAuthState();
  }

  async isGuestAccessBlocked() {
    return Boolean(await firstVisible([
      this.page.locator('[data-testid="login-button"]'),
      this.page.locator('[role="dialog"]:has-text("Download for Mac")'),
      this.page.locator('[role="dialog"]:has-text("Download app")'),
    ]));
  }

  assistantMessages() {
    return this.page.locator(
      '[data-testid="assistant-message"], [role="article"]:not(:has(div:has-text("You"))), div[class*="assistant-message"]',
    );
  }

  userMessages() {
    return this.page.locator(
      '[data-testid="user-message"], [role="article"]:has(div:has-text("You")), div[class*="user-message"]',
    );
  }

  conversationMessages() {
    return this.page.locator(
      '[data-testid="user-message"], [data-testid="assistant-message"], [role="article"]',
    );
  }

  async messageIdentity(message) {
    const testId = await message.getAttribute("data-testid").catch(() => null);
    const scope = testId === "user-message"
      ? this.userMessages()
      : this.assistantMessages();
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
    const response = message.locator('[data-testid="message-content"], .prose, [class*="markdown" i]');
    if (await response.count().catch(() => 0) > 0) {
      const text = await response.last().innerText().catch(() => "");
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
      message.getByRole("button", { name: /retry|try again|upgrade|重试|升级/i }),
      this.page.getByRole("button", { name: /retry|try again|upgrade|重试|升级/i }),
      message.locator('[class*="error" i], [data-testid*="error" i]'),
    ]);
    return control ? text.trim().slice(0, 120) : null;
  }

  async findGenerationErrorMarker(message) {
    const text = await message.innerText().catch(() => "");
    if (!/something went wrong|failed to generate|generation failed|try again|生成失败|出错了/i.test(text)) {
      return null;
    }
    const control = await firstVisible([
      message.getByRole("button", { name: /retry|try again|重试|重新生成/i }),
      this.page.getByRole("button", { name: /retry|try again|重试|重新生成/i }),
      message.locator('[class*="error" i], [data-testid*="error" i]'),
    ]);
    return control ? text.trim().slice(0, 120) : null;
  }

  async dismissTransientOverlays() {
    const closeButtons = [
      this.page.locator('[role="dialog"] button[aria-label*="close" i]'),
      this.page.locator('[role="dialog"] button:has-text("Close")'),
      this.page.locator('[aria-modal="true"] button[aria-label*="close" i]'),
    ];
    const button = await firstVisible(closeButtons);
    if (button) {
      await button.click().catch(() => null);
    }
  }

  deadRequestGraceMultiplier() {
    return 3;
  }
}
