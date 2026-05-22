import type { IAgent } from '../agent/types.js';
import type { LLMAdapter } from '../llm/types.js';
import type { Config, AgentDef, SubprocessAgentDef, LLMAgentDef, BrowserAgentDef } from '../config/types.js';
import type { DataStore } from '../persistence/types.js';
import { SubprocessAgent } from '../agent/subprocess/adapter.js';
import { parseOpenClawOutput } from '../agent/subprocess/integrations/generic.js';
import { LLMAgent } from '../llm/agent.js';
import { BrowserAgent, getSite } from '../agent/browser/adapter.js';
import { registerBuiltinSites } from '../agent/browser/sites/index.js';
import { ProviderRegistry } from './provider-registry.js';

// Register built-in browser site configs at import time
registerBuiltinSites();

export class AgentRegistry {
  private agents: Map<string, IAgent> = new Map();
  private llmAdapterCache: Map<string, LLMAdapter> = new Map();
  private providerRegistry: ProviderRegistry;

  constructor(private store: DataStore) {
    this.providerRegistry = new ProviderRegistry();
  }

  async boot(config: Config): Promise<void> {
    for (const def of config.agents) {
      try {
        const agent = this.createAgent(def);
        this.agents.set(agent.id, agent);

        const health = await agent.health();
        await this.store.saveAgent({
          id: agent.id,
          name: agent.name,
          capabilities: agent.capabilities,
          type: agent.type,
          status: health.status === 'healthy' || health.status === 'degraded' ? 'online' : 'offline',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
        });
      } catch (e) {
        console.error(`Failed to boot agent "${def.id}":`, e);
      }
    }
  }

  register(agent: IAgent): void {
    this.agents.set(agent.id, agent);
    this.store.saveAgent({
      id: agent.id,
      name: agent.name,
      capabilities: agent.capabilities,
      type: agent.type,
      status: 'online',
      lastHeartbeat: Date.now(),
      registeredAt: Date.now(),
    });
  }

  async unregister(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (agent) {
      await agent.shutdown();
      this.agents.delete(id);
    }
    await this.store.deleteAgent(id);
  }

  get(id: string): IAgent | undefined {
    return this.agents.get(id);
  }

  list(): IAgent[] {
    return [...this.agents.values()];
  }

  getOnline(): IAgent[] {
    return [...this.agents.values()];
  }

  findByCapability(capability: string): IAgent[] {
    const lower = capability.toLowerCase();
    return this.list().filter((agent) =>
      agent.capabilities.some(
        (cap) => cap === '*' || cap.toLowerCase().includes(lower)
      )
    );
  }

  async shutdown(): Promise<void> {
    for (const agent of this.agents.values()) {
      try {
        await agent.shutdown();
      } catch {
        // best effort
      }
    }
    this.agents.clear();
  }

  getLLMAdapter(agentId: string): LLMAdapter | null {
    return this.llmAdapterCache.get(agentId) ?? null;
  }

  detectInstalled(): string[] {
    return this.providerRegistry.detectInstalled();
  }

  printDetectedHints(): void {
    const configuredIds = new Set(this.list().map((a) => a.id));
    this.providerRegistry.printDetectedHints(configuredIds);
  }

  get providerCatalog() {
    return this.providerRegistry;
  }

  private createAgent(def: AgentDef): IAgent {
    if (def.type === 'subprocess') {
      return this.createSubprocessAgent(def);
    }
    if (def.type === 'llm') {
      return this.createLLMAgent(def);
    }
    if (def.type === 'browser') {
      return this.createBrowserAgent(def);
    }
    throw new Error(`Unknown agent type for "${(def as AgentDef).id}"`);
  }

  private createSubprocessAgent(def: SubprocessAgentDef): SubprocessAgent {
    return new SubprocessAgent({
      id: def.id,
      name: def.name,
      capabilities: def.capabilities,
      command: def.command,
      args: def.args,
      env: def.env,
      cwd: def.cwd,
      timeoutMs: def.timeoutMs,
      promptMode: def.promptMode ?? (def.args.some((a) => a.includes('{prompt}')) ? 'argument' : 'stdin'),
      parseOutput: def.command === 'openclaw' ? parseOpenClawOutput : undefined,
    });
  }

  private createBrowserAgent(def: BrowserAgentDef): BrowserAgent {
    const site = getSite(def.site);
    if (!site) throw new Error(`Unknown browser site: ${def.site}`);
    return new BrowserAgent({
      id: def.id,
      name: def.name,
      capabilities: def.capabilities,
      site,
      timeoutMs: def.timeoutMs,
    });
  }

  private createLLMAgent(def: LLMAgentDef): LLMAgent {
    let adapter: LLMAdapter;

    const cacheKey = `${def.provider}:${def.model}:${def.id}`;
    const cached = this.llmAdapterCache.get(cacheKey);
    if (cached) {
      adapter = cached;
    } else {
      adapter = this.buildLLMAdapter(def.provider, def.model, def.apiKey, def.endpoint, def.vision);
      // Allow config to override the adapter's default vision support
      if (def.vision !== undefined && adapter.supportsVision !== def.vision) {
        const origChat = adapter.chat.bind(adapter);
        adapter = {
          provider: adapter.provider,
          model: adapter.model,
          supportsVision: def.vision,
          chat: origChat,
        };
      }
      this.llmAdapterCache.set(cacheKey, adapter);
      this.llmAdapterCache.set(def.id, adapter);
    }

    return new LLMAgent(def.id, def.name, def.capabilities, adapter);
  }

  private buildLLMAdapter(
    provider: string,
    model: string,
    apiKey: string,
    endpoint?: string,
    vision?: boolean
  ): LLMAdapter {
    return this.providerRegistry.createLLMAdapter(provider, model, apiKey, endpoint, vision);
  }
}
