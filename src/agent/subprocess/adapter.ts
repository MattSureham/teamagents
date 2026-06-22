import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IAgent, AgentHealth, AgentResponse, MeetingPrompt } from '../types.js';
import { SubprocessManager } from './manager.js';

export interface SubprocessAgentConfig {
  id: string;
  name: string;
  capabilities: string[];
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  promptMode: 'argument' | 'stdin' | 'file';
  buildArgs?: (prompt: MeetingPrompt) => string[];
  buildInput?: (prompt: MeetingPrompt) => string;
  parseOutput?: (stdout: string) => string;
}

export class SubprocessAgent implements IAgent {
  readonly type = 'subprocess';
  readonly id: string;
  readonly name: string;
  readonly capabilities: string[];
  get timeoutMs() { return this.config.timeoutMs; }
  private manager: SubprocessManager;
  private config: SubprocessAgentConfig;

  constructor(config: SubprocessAgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.capabilities = config.capabilities;
    this.config = config;
    this.manager = new SubprocessManager();
  }

  async respond(prompt: MeetingPrompt): Promise<AgentResponse> {
    const promptText = this.buildPromptText(prompt);

    if (this.config.promptMode === 'file') {
      return this.respondViaFile(prompt, promptText);
    }
    if (this.config.promptMode === 'stdin') {
      return this.respondViaStdin(prompt, promptText);
    }

    // Argument mode — if prompt is too large for the Windows command line, fall back to stdin
    if (promptText.length > 28000) {
      return this.respondViaStdinFallback(prompt, promptText);
    }
    // On Windows, multi-line arguments get mangled by CreateProcess command-line joining
    if (process.platform === 'win32' && promptText.includes('\n')) {
      return this.respondViaStdinFallback(prompt, promptText);
    }
    return this.respondViaArgs(prompt);
  }

  /** Effective cwd: agent's configured cwd takes priority, meeting workDir is fallback. */
  private effectiveCwd(prompt: MeetingPrompt): string | undefined {
    return this.config.cwd ?? prompt.workDir;
  }

  /** Effective env: inherit agent config env, inject $MEETING_WORKTREE if set. */
  private effectiveEnv(prompt: MeetingPrompt): Record<string, string> | undefined {
    const base = this.config.env ? { ...this.config.env } : undefined;
    if (prompt.workDir) {
      return { ...base, MEETING_WORKTREE: prompt.workDir };
    }
    return base;
  }

  private async respondViaStdinFallback(prompt: MeetingPrompt, promptText: string): Promise<AgentResponse> {
    const args = this.buildStdinArgs();

    const result = await this.manager.run({
      command: this.config.command,
      args,
      cwd: this.effectiveCwd(prompt),
      env: this.effectiveEnv(prompt),
      timeoutMs: this.config.timeoutMs,
      input: promptText,
      signal: prompt.signal,
    });

    if (result.timedOut) {
      return { content: `[${this.name} did not respond within the time limit]` };
    }
    return { content: this.formatOutput(result.stdout, result.stderr) };
  }

  private replaceTokens(args: string[], prompt: MeetingPrompt, promptText: string, filePath?: string): string[] {
    return args.map((a) => {
      let result = a;
      if (result === '{prompt}') result = promptText;
      else result = result.replace('{prompt}', promptText);
      result = result.replace('{meetingId}', prompt.meetingId);
      if (filePath) result = result.replace('{file}', filePath);
      return result;
    });
  }

  private formatOutput(stdout: string, stderr: string): string {
    const raw = stdout || stderr || `[${this.name} produced no output]`;
    if (stdout && this.config.parseOutput) {
      return this.config.parseOutput(stdout);
    }
    return raw;
  }

  private async respondViaArgs(prompt: MeetingPrompt): Promise<AgentResponse> {
    const promptText = this.buildPromptText(prompt);
    const args = this.replaceTokens(this.config.args, prompt, promptText);

    const result = await this.manager.run({
      command: this.config.command,
      args,
      cwd: this.effectiveCwd(prompt),
      env: this.effectiveEnv(prompt),
      timeoutMs: this.config.timeoutMs,
      signal: prompt.signal,
    });

    if (result.timedOut) {
      return { content: `[${this.name} did not respond within the time limit]` };
    }
    return { content: this.formatOutput(result.stdout, result.stderr) };
  }

  private buildStdinArgs(): string[] {
    const result: string[] = [];
    for (const arg of this.config.args) {
      if (arg === '{prompt}') {
        // Standalone token — handle the preceding flag
        if (result.length > 0) {
          const prev = result[result.length - 1];
          if (prev === '-p') {
            // Claude Code: --print + stdin reads stdin in non-interactive mode
            result[result.length - 1] = '--print';
          } else {
            // Generic: remove the flag (e.g. -q) since prompt goes via stdin
            result.pop();
          }
        }
        continue;
      }
      if (arg.includes('{prompt}')) {
        // Embedded in another string — replace with stdin marker
        result.push(arg.replace('{prompt}', '-'));
        continue;
      }
      result.push(arg);
    }
    return result;
  }

  private async respondViaStdin(prompt: MeetingPrompt, promptText: string): Promise<AgentResponse> {
    const args = this.buildStdinArgs();
    const result = await this.manager.run({
      command: this.config.command,
      args,
      cwd: this.effectiveCwd(prompt),
      env: this.effectiveEnv(prompt),
      timeoutMs: this.config.timeoutMs,
      input: promptText,
      signal: prompt.signal,
    });

    if (result.timedOut) {
      return { content: `[${this.name} did not respond within the time limit]` };
    }
    return { content: this.formatOutput(result.stdout, result.stderr) };
  }

  private async respondViaFile(prompt: MeetingPrompt, promptText: string): Promise<AgentResponse> {
    const dir = await mkdtemp(join(tmpdir(), 'agent-meeting-'));
    const filePath = join(dir, 'prompt.txt');

    try {
      await writeFile(filePath, promptText, 'utf-8');

      const args = this.replaceTokens(this.config.args, prompt, promptText, filePath);

      const result = await this.manager.run({
        command: this.config.command,
        args,
        cwd: this.effectiveCwd(prompt),
        env: this.effectiveEnv(prompt),
        timeoutMs: this.config.timeoutMs,
        signal: prompt.signal,
      });

      if (result.timedOut) {
        return { content: `[${this.name} did not respond within the time limit]` };
      }
      return { content: this.formatOutput(result.stdout, result.stderr) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async health(): Promise<AgentHealth> {
    const start = Date.now();
    try {
      const exists = await this.manager.healthCheck(this.config.command);
      if (!exists) {
        return { status: 'offline', lastCheck: Date.now(), error: `Command "${this.config.command}" not found` };
      }
      return { status: 'healthy', lastCheck: Date.now(), latencyMs: Date.now() - start };
    } catch (e) {
      return { status: 'unhealthy', lastCheck: Date.now(), error: String(e) };
    }
  }

  async shutdown(): Promise<void> {
    await this.manager.shutdown();
  }

  private buildPromptText(prompt: MeetingPrompt): string {
    const maxMessages = 8;
    const transcript = prompt.transcript;
    let transcriptLines: string[];

    if (transcript.length <= maxMessages) {
      transcriptLines = transcript.map((m) => `[${m.authorName} (${m.phase})]: ${m.content}`);
    } else {
      const recent = transcript.slice(-maxMessages);
      transcriptLines = [
        `[Showing last ${maxMessages} of ${transcript.length} total messages]`,
        ...recent.map((m) => `[${m.authorName} (${m.phase})]: ${m.content}`),
      ];
    }

    const phase = prompt.phase;
    const phaseGuidance = phase === 'build'
      ? 'You are in a BUILD phase. Use your tools to read existing files, write code, run commands, and implement ONE piece of the project.'
      : phase === 'wrapup'
        ? 'You are in the final WRAP-UP phase. Do not modify files. Provide the concrete final answer, recommendation, or方案, and put unfinished work in a brief continue-next-time note.'
        : 'You are in a DISCUSSION phase. You may use tools to read files, search the web, or gather information as needed to inform your response. However, do not write code or modify files — focus on analysis, reasoning, and discussion.';

    return [
      `You are "${this.name}" participating in a structured meeting.`,
      `MEETING TOPIC: ${prompt.topic}`,
      `BACKGROUND: ${prompt.background || 'None provided.'}`,
      `CURRENT PHASE: ${prompt.phase.toUpperCase()}`,
      '',
      phaseGuidance,
      '',
      'CONVERSATION SO FAR:',
      ...transcriptLines,
      '',
      `YOUR TURN — ${prompt.currentPrompt}`,
    ].join('\n');
  }
}
