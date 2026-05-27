import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { IAgent, AgentHealth, AgentResponse, MeetingPrompt } from '../types.js';
import type { SiteConfig } from './types.js';

export interface BrowserAgentConfig {
  id: string;
  name: string;
  capabilities: string[];
  site: SiteConfig;
  timeoutMs?: number;
}

const knownSites: Record<string, SiteConfig> = {};

export function registerSite(config: SiteConfig): void {
  knownSites[config.id] = config;
}

export function getSite(id: string): SiteConfig | undefined {
  return knownSites[id];
}

export class BrowserAgent implements IAgent {
  readonly type = 'browser';
  readonly id: string;
  readonly name: string;
  readonly capabilities: string[];
  private site: SiteConfig;
  readonly timeoutMs: number;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(config: BrowserAgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.capabilities = config.capabilities;
    this.site = config.site;
    this.timeoutMs = config.timeoutMs ?? 120_000;
  }

  async open(): Promise<void> {
    await this.getPage();
    await this.page!.goto(this.site.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  async respond(prompt: MeetingPrompt): Promise<AgentResponse> {
    try {
      const page = await this.getPage();

      // Navigate to a fresh chat if configured
      const startUrl = this.site.newChatUrl ?? this.site.url;

      // Only navigate if we're not already there (or if it's a new-chat URL)
      if (!page.url().startsWith(startUrl) || this.site.newChatUrl) {
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        // Let the page settle
        await page.waitForTimeout(2000);
      }

      // If the page has a new-chat / clear button after navigation, try to use it
      if (this.site.clearChatSelector) {
        try {
          const clearBtn = page.locator(this.site.clearChatSelector);
          if (await clearBtn.isVisible({ timeout: 3000 })) {
            await clearBtn.click();
            await page.waitForTimeout(1000);
          }
        } catch {
          // not available, keep going
        }
      }

      // Type the prompt
      const promptText = this.buildPromptText(prompt);
      const input = page.locator(this.site.inputSelector).first();
      await input.waitFor({ state: 'visible', timeout: 15_000 });
      await input.click();
      await page.waitForTimeout(300);
      await input.fill(promptText);
      await page.waitForTimeout(300);

      // Submit
      if (this.site.submitSelector) {
        await page.locator(this.site.submitSelector).first().click();
      } else {
        await input.press('Enter');
      }

      // Wait for response
      await this.waitForResponse(page);

      // Extract the last assistant response
      const responses = page.locator(this.site.responseSelector);
      const count = await responses.count();
      if (count === 0) {
        return { content: `[${this.name} produced no visible response]` };
      }

      const lastResponse = responses.nth(count - 1);
      const content = (await lastResponse.textContent())?.trim() ?? '';

      return { content: content || `[${this.name} produced an empty response]` };
    } catch (e) {
      return { content: `[${this.name} error: ${(e as Error).message}]` };
    }
  }

  async health(): Promise<AgentHealth> {
    try {
      if (!this.context) {
        return { status: 'offline', lastCheck: Date.now() };
      }
      await this.context.pages();
      return { status: 'healthy', lastCheck: Date.now() };
    } catch {
      return { status: 'unhealthy', lastCheck: Date.now() };
    }
  }

  async shutdown(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
      this.page = null;
    }
  }

  private async getPage(): Promise<Page> {
    if (!this.context) {
      const userDataDir = join(homedir(), '.agent-meetings', 'browser', this.id);
      this.context = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
        ],
        viewport: { width: 1280, height: 900 },
      });
    }

    if (!this.page || this.page.isClosed()) {
      const pages = this.context.pages();
      this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    }

    return this.page;
  }

  private async waitForResponse(page: Page): Promise<void> {
    const strategy = this.site.waitStrategy;
    const timeout = this.timeoutMs;

    if (strategy === 'stop-button' && this.site.stopButtonSelector) {
      // Wait for the stop button to appear (generation started), then disappear (generation done)
      try {
        const stopBtn = page.locator(this.site.stopButtonSelector).first();
        await stopBtn.waitFor({ state: 'visible', timeout: 15_000 });
        await stopBtn.waitFor({ state: 'hidden', timeout });
      } catch {
        // if stop button never appears, fall through to fixed delay
        await page.waitForTimeout(5000);
      }
    } else if (strategy === 'typing-indicator' && this.site.typingIndicatorSelector) {
      try {
        const indicator = page.locator(this.site.typingIndicatorSelector).first();
        // Wait for indicator to appear then disappear
        await indicator.waitFor({ state: 'visible', timeout: 10_000 });
        await indicator.waitFor({ state: 'hidden', timeout });
      } catch {
        await page.waitForTimeout(5000);
      }
    } else {
      // fixed-delay fallback
      await page.waitForTimeout(this.site.waitAfterMs ?? 30_000);
    }
  }

  private buildPromptText(prompt: MeetingPrompt): string {
    return [
      `Meeting topic: ${prompt.topic}`,
      `Current phase: ${prompt.phase.toUpperCase()}`,
      '',
      prompt.currentPrompt,
    ].join('\n');
  }
}
