import { execSync } from 'node:child_process';
import type { LLMAdapter } from '../llm/types.js';
import {
  LLM_PROVIDERS,
  SUBPROCESS_TOOLS,
  BROWSER_SITES,
  type LLMProviderEntry,
  type SubprocessToolEntry,
  type BrowserSiteEntry,
} from '../config/provider-catalog.js';

export class ProviderRegistry {
  private detectedTools: string[] | null = null;

  // ── LLM Providers ──────────────────────────────────────────────────────

  listLLMProviders(): Array<[string, LLMProviderEntry]> {
    return Object.entries(LLM_PROVIDERS);
  }

  getLLMProvider(id: string): LLMProviderEntry | undefined {
    return LLM_PROVIDERS[id];
  }

  createLLMAdapter(
    providerId: string,
    model: string,
    apiKey: string,
    endpoint?: string,
    vision?: boolean
  ): LLMAdapter {
    const entry = this.getLLMProvider(providerId);
    if (!entry) {
      throw new Error(
        `Unknown LLM provider: "${providerId}". ` +
        `Available: ${Object.keys(LLM_PROVIDERS).join(', ')}`
      );
    }
    const mergedEndpoint = endpoint ?? entry.defaultEndpoint;
    return entry.createAdapter(apiKey, model, mergedEndpoint, vision);
  }

  // ── Subprocess Tools ───────────────────────────────────────────────────

  listSubprocessTools(): Array<[string, SubprocessToolEntry]> {
    return Object.entries(SUBPROCESS_TOOLS);
  }

  listDetectedTools(): Array<[string, SubprocessToolEntry]> {
    const installed = this.detectInstalled();
    return Object.entries(SUBPROCESS_TOOLS).filter(([id]) => installed.includes(id));
  }

  getSubprocessTool(id: string): SubprocessToolEntry | undefined {
    return SUBPROCESS_TOOLS[id];
  }

  // ── Browser Sites ──────────────────────────────────────────────────────

  listBrowserSites(): Array<[string, BrowserSiteEntry]> {
    return Object.entries(BROWSER_SITES);
  }

  getBrowserSite(id: string): BrowserSiteEntry | undefined {
    return BROWSER_SITES[id];
  }

  // ── Auto-Detection ─────────────────────────────────────────────────────

  detectInstalled(): string[] {
    if (this.detectedTools !== null) return this.detectedTools;

    const checkCmd = process.platform === 'win32' ? 'where' : 'which';
    const detected: string[] = [];

    for (const [id, entry] of Object.entries(SUBPROCESS_TOOLS)) {
      try {
        const cmd = entry.detectCommand ?? entry.command;
        execSync(`${checkCmd} ${cmd}`, { stdio: 'ignore' });
        detected.push(id);
      } catch {
        // tool not found
      }
    }

    this.detectedTools = detected;
    return detected;
  }

  printDetectedHints(configuredIds: Set<string>): void {
    const detected = this.detectInstalled();
    const unconfigured = detected.filter((id) => !configuredIds.has(id));

    if (unconfigured.length === 0) return;

    console.log('\nDetected tools not in config:');
    for (const id of unconfigured) {
      const entry = SUBPROCESS_TOOLS[id];
      console.log(`  ${id} — ${entry?.name ?? id} (${entry?.command ?? '?'})`);
    }
    console.log('Add them to meetings.config.yml to use them as agents.\n');
  }
}