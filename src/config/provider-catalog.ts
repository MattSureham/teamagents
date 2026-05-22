import type { LLMAdapter } from '../llm/types.js';
import { AnthropicAdapter } from '../llm/anthropic.js';
import { OpenAIAdapter } from '../llm/openai.js';
import { GeminiAdapter } from '../llm/gemini.js';
import { OllamaAdapter } from '../llm/ollama.js';
import { DeepSeekAdapter } from '../llm/deepseek.js';
import { MinimaxAdapter } from '../llm/minimax.js';
import { QwenAdapter } from '../llm/qwen.js';
import { KimiAdapter } from '../llm/kimi.js';
import { KimiCodeAdapter } from '../llm/kimi-code.js';
import { OpenAICompatAdapter } from '../llm/openai-compat.js';

// ── LLM Provider Catalog ──────────────────────────────────────────────────

export interface LLMProviderEntry {
  provider: string;
  name: string;
  defaultModel: string;
  defaultEndpoint?: string;
  requiresApiKey: boolean;
  createAdapter: (
    apiKey: string,
    model: string,
    endpoint?: string,
    vision?: boolean
  ) => LLMAdapter;
}

export const LLM_PROVIDERS: Record<string, LLMProviderEntry> = {
  anthropic: {
    provider: 'anthropic',
    name: 'Anthropic (Claude)',
    defaultModel: 'claude-sonnet-4-20250514',
    requiresApiKey: true,
    createAdapter: (apiKey, model) => new AnthropicAdapter(apiKey, model),
  },
  openai: {
    provider: 'openai',
    name: 'OpenAI (GPT-4o)',
    defaultModel: 'gpt-4o',
    requiresApiKey: true,
    createAdapter: (apiKey, model) => new OpenAIAdapter(apiKey, model),
  },
  gemini: {
    provider: 'gemini',
    name: 'Google Gemini',
    defaultModel: 'gemini-2.0-flash',
    requiresApiKey: true,
    createAdapter: (apiKey, model) => new GeminiAdapter(apiKey, model),
  },
  ollama: {
    provider: 'ollama',
    name: 'Ollama (Local)',
    defaultModel: 'mistral',
    defaultEndpoint: 'http://127.0.0.1:11434/v1',
    requiresApiKey: false,
    createAdapter: (_, model, endpoint) => new OllamaAdapter(model, endpoint),
  },
  'openai-compat': {
    provider: 'openai-compat',
    name: 'OpenAI-Compatible (vLLM, LM Studio, etc.)',
    defaultModel: 'local-model',
    defaultEndpoint: 'http://127.0.0.1:8000/v1',
    requiresApiKey: false,
    createAdapter: (apiKey, model, endpoint, vision) =>
      new OpenAICompatAdapter(apiKey, model, endpoint, vision),
  },
  deepseek: {
    provider: 'deepseek',
    name: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    requiresApiKey: true,
    createAdapter: (apiKey, model) => new DeepSeekAdapter(apiKey, model),
  },
  minimax: {
    provider: 'minimax',
    name: 'MiniMax',
    defaultModel: 'abab6.5s-chat',
    requiresApiKey: true,
    createAdapter: (apiKey, model) => new MinimaxAdapter(apiKey, model),
  },
  qwen: {
    provider: 'qwen',
    name: 'Alibaba Qwen',
    defaultModel: 'qwen-max',
    requiresApiKey: true,
    createAdapter: (apiKey, model) => new QwenAdapter(apiKey, model),
  },
  kimi: {
    provider: 'kimi',
    name: 'Moonshot Kimi',
    defaultModel: 'kimi-latest',
    requiresApiKey: true,
    createAdapter: (apiKey, model) => new KimiAdapter(apiKey, model),
  },
  'kimi-code': {
    provider: 'kimi-code',
    name: 'Moonshot Kimi for Coding',
    defaultModel: 'kimi-for-coding',
    requiresApiKey: true,
    createAdapter: (apiKey, model) => new KimiCodeAdapter(apiKey, model),
  },
};

// ── Subprocess Tool Catalog ────────────────────────────────────────────────

export interface SubprocessToolEntry {
  tool: string;
  name: string;
  description: string;
  command: string;
  defaultArgs: string[];
  defaultPromptMode: 'argument' | 'stdin';
  defaultTimeoutMs: number;
  detectCommand?: string; // alternative command to check existence, e.g., 'codex' for 'codex-app-server'
}

export const SUBPROCESS_TOOLS: Record<string, SubprocessToolEntry> = {
  'claude-code': {
    tool: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic Claude Code CLI — full-featured coding agent with tool use',
    command: 'claude',
    defaultArgs: ['-p', '{prompt}', '--output-format', 'text', '--permission-mode', 'bypassPermissions', '--bare'],
    defaultPromptMode: 'argument',
    defaultTimeoutMs: 3_600_000,
  },
  codex: {
    tool: 'generic',
    name: 'Codex (OpenAI)',
    description: 'OpenAI Codex CLI — coding agent with sandboxed execution',
    command: 'codex',
    defaultArgs: ['exec', '{prompt}', '--full-auto'],
    defaultPromptMode: 'argument',
    defaultTimeoutMs: 1_800_000,
  },
  opencode: {
    tool: 'generic',
    name: 'OpenCode',
    description: 'OpenCode CLI — open-source coding agent',
    command: 'opencode',
    defaultArgs: ['run', '{prompt}', '-m', 'deepseek/deepseek-v4-pro', '--dangerously-skip-permissions'],
    defaultPromptMode: 'argument',
    defaultTimeoutMs: 1_800_000,
  },
  'gemini-cli': {
    tool: 'generic',
    name: 'Gemini CLI',
    description: 'Google Gemini CLI — coding agent with Google Cloud integration',
    command: 'gemini',
    defaultArgs: ['{prompt}'],
    defaultPromptMode: 'stdin',
    defaultTimeoutMs: 600_000,
    detectCommand: 'gemini',
  },
  'cursor-agent': {
    tool: 'generic',
    name: 'Cursor Agent',
    description: 'Cursor CLI agent mode — coding agent from the Cursor editor team',
    command: 'cursor-agent',
    defaultArgs: ['{prompt}'],
    defaultPromptMode: 'stdin',
    defaultTimeoutMs: 600_000,
  },
  aider: {
    tool: 'generic',
    name: 'Aider',
    description: 'Aider AI pair programming CLI',
    command: 'aider',
    defaultArgs: ['--message', '{prompt}'],
    defaultPromptMode: 'argument',
    defaultTimeoutMs: 1_800_000,
  },
};

// ── Browser Site Catalog ──────────────────────────────────────────────────

export interface BrowserSiteEntry {
  site: string;
  name: string;
  description: string;
}

export const BROWSER_SITES: Record<string, BrowserSiteEntry> = {
  chatgpt: {
    site: 'chatgpt',
    name: 'ChatGPT',
    description: 'OpenAI ChatGPT — free web chat interface',
  },
  claude: {
    site: 'claude',
    name: 'Claude Web',
    description: 'Anthropic Claude.ai — free web chat interface',
  },
  gemini: {
    site: 'gemini',
    name: 'Gemini Web',
    description: 'Google Gemini — free web chat interface',
  },
  deepseek: {
    site: 'deepseek',
    name: 'DeepSeek Web',
    description: 'DeepSeek Chat — free web chat interface',
  },
};
