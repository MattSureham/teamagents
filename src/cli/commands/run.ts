import { Command } from 'commander';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../config/loader.js';
import { AgentRegistry } from '../../server/agent-registry.js';
import { JsonFileStore } from '../../persistence/json-store.js';
import { MeetingEngine } from '../../meeting/engine.js';
import { formatLog } from '../../meeting/format-log.js';
import type { IAgent } from '../../agent/types.js';
import { loadContext } from '../../utils/context-loader.js';
import { WorktreeManager } from '../../worktree/manager.js';
import type { MeetingMode } from '../../meeting/types.js';

const MEETING_MODES: MeetingMode[] = ['debate', 'discussion', 'collaboration'];

export function runCommand(): Command {
  return new Command('run')
    .description('Run a meeting — one command, no server needed')
    .requiredOption('-t, --topic <topic>', 'Meeting topic')
    .option('-a, --agents <ids>', 'Comma-separated agent IDs from your config')
    .option('--preset <name>', 'Use a named preset from config (merges with --agents if both given)')
    .option('-m, --moderator <id>', 'Agent ID to act as moderator')
    .option('-x, --context <text>', 'Background context (text or path to a file)')
    .option('-c, --config <path>', 'Path to config file', './meetings.config.yml')
    .option('--turn-timeout <ms>', 'Turn timeout in ms', '60000')
    .option('--rebuttal-rounds <n>', 'Max rebuttal rounds', '1')
    .option('--deliberation-rounds <n>', 'Max deliberation rounds (each round, every participant speaks)', '3')
    .option('--plan-rounds <n>', 'Max plan rounds (collaboration)', '1')
    .option('--build-rounds <n>', 'Max build rounds (collaboration)', '3')
    .option('--review-rounds <n>', 'Max review rounds (collaboration)', '1')
    .option('--total-rounds <n>', 'Max total rounds before summary', '50')
    .option('--mode <mode>', 'Meeting mode: debate, discussion, or collaboration', 'debate')
    .option('--speaker-order <ids>', 'Comma-separated agent IDs to speak first/in order')
    .option('--work-dir <path>', 'Shared working directory for agents to build in (collaboration mode)')
    .option('--worktree', 'Create an isolated git worktree as the working directory (collaboration mode)')
    .option('--no-stream', 'Do not stream transcript; only show summary at the end')
    .action(async (options) => {
      let config;
      try {
        config = loadConfig(options.config);
      } catch (e) {
        console.error('Failed to load config:', (e as Error).message);
        process.exit(1);
      }

      // Resolve context — supports text, PDF, DOCX, images, directories
      let context = '';
      let contextImages: { data: string; mimeType: string }[] = [];
      if (options.context) {
        const cp = await loadContext(options.context);
        context = cp.text;
        contextImages = cp.images.map((img) => ({ data: img.data, mimeType: img.mimeType }));
        if (cp.images.length > 0 || existsSync(options.context)) {
          const label = existsSync(options.context) ? options.context : 'context';
          console.error(`Loaded ${cp.text.length} chars + ${cp.images.length} image(s) from ${label}`);
        }
      }

      // Resolve agents — from preset, explicit --agents, or both
      if (!options.agents && !options.preset) {
        console.error('Either --agents or --preset is required (or both).');
        if (config.meetings.presets) {
          console.error('Available presets:');
          for (const name of Object.keys(config.meetings.presets).sort()) {
            const p = config.meetings.presets[name];
            console.error(`  ${name} → ${p.agents.join(', ')}${p.moderator ? ` [moderator: ${p.moderator}]` : ''}`);
          }
        }
        process.exit(1);
      }

      const requestedIds = new Set<string>();

      // Load preset agents first
      if (options.preset) {
        const preset = config.meetings.presets?.[options.preset];
        if (!preset) {
          console.error(`Preset "${options.preset}" not found in config. Available presets:`);
          if (config.meetings.presets) {
            for (const name of Object.keys(config.meetings.presets).sort()) {
              console.error(`  ${name}`);
            }
          }
          process.exit(1);
        }
        for (const id of preset.agents) requestedIds.add(id);
      }

      // Merge explicit --agents (after preset, so they can add extras)
      if (options.agents) {
        for (const id of options.agents.split(',').map((s: string) => s.trim())) {
          requestedIds.add(id);
        }
      }

      const registry = new AgentRegistry(new JsonFileStore(config.server.dataDir));
      await registry.boot(config);

      const participants: IAgent[] = [];
      for (const id of requestedIds) {
        const agent = registry.get(id);
        if (!agent) {
          console.error(`Agent "${id}" not found in config. Available agents:`);
          for (const a of registry.list()) {
            console.error(`  ${a.id} — ${a.name} [${a.type}]`);
          }
          await registry.shutdown();
          process.exit(1);
        }
        participants.push(agent);
      }

      const presetModerator = options.preset
        ? config.meetings.presets?.[options.preset]?.moderator
        : undefined;
      const moderatorId = options.moderator ?? presetModerator ?? config.meetings.defaultModerator;
      const moderatorAgent = registry.get(moderatorId);

      console.log('╔══════════════════════════════════════════════╗');
      console.log('║         AGENT MEETINGS — Live Session         ║');
      console.log('╠══════════════════════════════════════════════╣');
      console.log(`║ Topic: ${padRight(options.topic.slice(0, 36), 36)} ║`);
      console.log('╠══════════════════════════════════════════════╣');
      console.log('║ Participants:                                 ║');
      for (const p of participants) {
        const label = `${p.name} (${p.type})`;
        console.log(`║   • ${padRight(label, 40)} ║`);
      }
      console.log(`║ Moderator: ${padRight(moderatorAgent?.name ?? moderatorId, 35)} ║`);
      console.log('╚══════════════════════════════════════════════╝');
      console.log();

      const store = new JsonFileStore(config.server.dataDir);
      await store.init();

      const mode = ((options.mode as string) ?? config.meetings.mode ?? 'debate') as MeetingMode;
      if (!MEETING_MODES.includes(mode)) {
        console.error(`Invalid mode "${mode}". Expected one of: ${MEETING_MODES.join(', ')}`);
        await registry.shutdown();
        process.exit(1);
      }

      const engine = new MeetingEngine({
        topic: options.topic,
        context,
        contextImages: contextImages.length > 0 ? contextImages : undefined,
        participants,
        moderatorId,
        mode,
        speakerOrder: parseIds(options.speakerOrder),
        workDir: options.workDir,
        turnTimeoutMs: parseInt(options.turnTimeout, 10),
        maxRebuttalRounds: parseInt(options.rebuttalRounds, 10),
        maxDeliberationRounds: parseInt(options.deliberationRounds, 10),
        maxPlanRounds: parseInt(options.planRounds, 10),
        maxBuildRounds: parseInt(options.buildRounds, 10),
        maxReviewRounds: parseInt(options.reviewRounds, 10),
        maxTotalRounds: parseInt(options.totalRounds, 10),
        defaultLLM: registry.getLLMAdapter(moderatorId) ?? undefined,
        onTurnStart: (name) => {
          if (stream) {
            process.stdout.write(`  ⏳ Waiting for ${name}...`);
          }
        },
        onTurnEnd: (name) => {
          if (stream) {
            process.stdout.write('\r\x1b[K'); // clear the waiting line
          }
        },
      });

      // Git worktree isolation
      const worktrees = new WorktreeManager();
      if (options.worktree) {
        try {
          const wtPath = worktrees.create(engine.id, config.server.dataDir, {
            baseRef: config.meetings.worktree?.baseRef,
            setupCommand: config.meetings.worktree?.setupCommand,
            archiveOnTeardown: config.meetings.worktree?.archiveOnTeardown,
          });
          worktrees.setup(wtPath, config.meetings.worktree?.setupCommand);
          engine.setWorkDir(wtPath);
          console.error(`Worktree created at: ${wtPath}`);
        } catch (e) {
          console.error('Failed to create worktree:', (e as Error).message);
        }
      }

      const phaseLabels: Record<string, string> = {
        opening: 'OPENING — topic introduction',
        position: 'POSITION — agents state their views',
        rebuttal: 'REBUTTAL — agents respond to each other',
        deliberation: 'DELIBERATION — free-form discussion',
        voting: 'VOTING — casting votes',
        plan: 'PLAN — agents propose approach',
        build: 'BUILD — agents implement',
        review: 'REVIEW — agents review output',
        summary: 'SUMMARY — final recap',
        concluded: 'CONCLUDED',
      };

      let lastPhase = '';
      const stream = options.stream !== false;

      if (stream) {
        // Hook into the engine to print messages as they happen
        const origPush = engine.transcript.push.bind(engine.transcript);
        engine.transcript.push = function (msg) {
          if (msg.phase !== lastPhase) {
            lastPhase = msg.phase;
            console.log(`\n─ ${phaseLabels[msg.phase] ?? msg.phase} ─`.padEnd(50, '─'));
          }

          const prefix = msg.authorId === '__system_moderator__'
            ? '◆'
            : '◇';
          const time = new Date(msg.timestamp).toLocaleTimeString();
          console.log(`  ${prefix} [${time}] ${msg.authorName}:`);

          // Print content with line wrapping
          for (const line of msg.content.split('\n')) {
            if (line.trim()) {
              console.log(`    ${line}`);
            } else {
              console.log();
            }
          }
          console.log();

          return origPush(msg);
        } as typeof engine.transcript.push;
      }

      try {
        await engine.start();
      } finally {
        // Teardown worktree if one was created
        const wtPath = worktrees.get(engine.id);
        if (wtPath) {
          worktrees.teardown(engine.id, wtPath, {
            archiveOnTeardown: config.meetings.worktree?.archiveOnTeardown,
          });
        }

        // Save the full meeting record before shutting down
        try {
          const stored = engine.toStoredMeeting();
          await store.saveMeeting(stored);

          // Write a human-readable log file
          const logPath = join(config.server.dataDir, 'meetings', `${engine.id}.log`);
          mkdirSync(join(config.server.dataDir, 'meetings'), { recursive: true });
          writeFileSync(logPath, formatLog(engine), 'utf-8');

          console.log(`\nMeeting record saved:`);
          console.log(`  JSON: ${join(config.server.dataDir, 'meetings', `${engine.id}.json`)}`);
          console.log(`  Log:  ${logPath}`);
        } catch (e) {
          console.error('Failed to save meeting record:', (e as Error).message);
        }
        await registry.shutdown();
      }

      // Summary
      if (engine.summary) {
        const isCollab = engine.mode === 'collaboration';
        console.log('═══════════════════════════════════════════════');
        console.log(isCollab ? '              PROJECT SUMMARY' : '              MEETING SUMMARY');
        console.log('═══════════════════════════════════════════════');
        console.log();
        console.log(`Outcome: ${engine.summary.consensus}`);
        console.log();
        console.log('Key Points:');
        for (const p of engine.summary.keyPoints) {
          console.log(`  • ${p}`);
        }
        console.log();
        if (isCollab) {
          if (engine.summary.deliverables && engine.summary.deliverables.length > 0) {
            console.log('Deliverables:');
            for (const d of engine.summary.deliverables) {
              console.log(`  • ${d}`);
            }
            console.log();
          }
          if (engine.summary.decisions && engine.summary.decisions.length > 0) {
            console.log('Key Decisions:');
            for (const d of engine.summary.decisions) {
              console.log(`  • ${d}`);
            }
            console.log();
          }
        } else {
          if (engine.summary.dissentingViews.length > 0) {
            console.log('Dissenting Views:');
            for (const v of engine.summary.dissentingViews) {
              console.log(`  • ${v}`);
            }
            console.log();
          }
          if (engine.summary.voteTally) {
            const t = engine.summary.voteTally;
            console.log(`Vote: YES=${t.yes ?? 0}  NO=${t.no ?? 0}  ABSTAIN=${t.abstain ?? 0}`);
            console.log();
          }
        }
        if (engine.summary.actionItems.length > 0) {
          console.log('Action Items:');
          for (const a of engine.summary.actionItems) {
            console.log(`  • ${a}`);
          }
          console.log();
        }
      }

      let endNote = `Meeting ${engine.id} concluded`;
      if (engine.reasonEnded === 'cancelled') {
        endNote += ' (cancelled)';
      }
      endNote += '.';
      console.log(endNote);
    });
}

function padRight(s: string, len: number): string {
  return s.length > len ? s.slice(0, len - 1) + '…' : s.padEnd(len);
}

function parseIds(value?: string): string[] | undefined {
  const ids = value?.split(',').map((id) => id.trim()).filter(Boolean);
  return ids && ids.length > 0 ? ids : undefined;
}
