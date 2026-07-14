import { Command } from 'commander';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../config/loader.js';
import { AgentRegistry } from '../../server/agent-registry.js';
import { JsonFileStore } from '../../persistence/json-store.js';
import { MeetingEngine } from '../../meeting/engine.js';
import { formatLog } from '../../meeting/format-log.js';
import type { IAgent } from '../../agent/types.js';
import { getDefaultConfigPath } from '../../utils/runtime-paths.js';

export function resumeCommand(): Command {
  return new Command('resume')
    .description('Resume an interrupted meeting')
    .argument('<meeting-id>', 'Meeting ID to resume')
    .option('-c, --config <path>', 'Path to config file', getDefaultConfigPath())
    .option('-s, --server <url>', 'Delegate to a running server')
    .option('--context <string>', 'Override or add context for the continuation')
    .option('--moderator <id>', 'Override the moderator agent')
    .option('--speaker-order <ids>', 'Comma-separated agent IDs to speak first/in order')
    .option('--rebuttal-rounds <n>', 'Override max rebuttal rounds')
    .option('--deliberation-rounds <n>', 'Override max deliberation rounds')
    .option('--plan-rounds <n>', 'Override max plan rounds')
    .option('--build-rounds <n>', 'Override max build rounds', '3')
    .option('--review-rounds <n>', 'Override max review rounds')
    .option('--total-rounds <n>', 'Override max total rounds')
    .option('--no-stream', 'Do not stream transcript; only show summary at the end')
    .action(async (meetingId, options) => {
      // Server-delegated resume
      if (options.server) {
        try {
          const res = await fetch(`${options.server}/meetings/${meetingId}/resume`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              speakerOrder: parseIds(options.speakerOrder),
            }),
          });
          const body = (await res.json()) as Record<string, unknown>;
          if (res.ok) {
            console.log(`Meeting resumed on server:`);
            console.log(`  ID: ${body.id}`);
            console.log(`  Topic: ${body.topic}`);
            console.log(`  Resumed from: ${body.resumedFrom}`);
            console.log(`  Transcript: ${body.transcriptLength} existing messages`);
          } else {
            console.error('Error:', body.error);
            process.exit(1);
          }
        } catch (e) {
          console.error('Failed to reach server:', e);
          process.exit(1);
        }
        return;
      }

      // Local resume
      let config;
      try {
        config = loadConfig(options.config);
      } catch (e) {
        console.error('Failed to load config:', (e as Error).message);
        process.exit(1);
      }

      const store = new JsonFileStore(config.server.dataDir);
      await store.init();

      const stored = await store.getMeeting(meetingId);
      if (!stored) {
        console.error(`Meeting "${meetingId}" not found.`);
        const all = await store.listMeetings();
        if (all.length > 0) {
          console.error('Available meetings:');
          for (const m of all.slice(0, 10)) {
            console.error(`  ${m.id} — "${m.topic}" [${m.status}, phase: ${m.currentPhase}]`);
          }
        }
        process.exit(1);
      }

      if (stored.status !== 'active' && stored.status !== 'concluded') {
        console.error(
          `Meeting status is "${stored.status}". Only active or concluded meetings can be resumed.`
        );
        process.exit(1);
      }

      const isContinuation = stored.status === 'concluded';

      // For concluded meetings, jump to an open discussion phase so agents
      // can dive deeper with full prior transcript as context.
      if (isContinuation) {
        const contPhase = stored.mode === 'collaboration' ? 'plan' : 'deliberation';
        console.error(`Continuing concluded meeting — jumping to ${contPhase} phase with full transcript.`);
        stored.currentPhase = contPhase;
        stored.resumePoint = undefined;
        if (stored.phaseTimeline.length > 0) {
          stored.phaseTimeline[stored.phaseTimeline.length - 1].exitedAt = Date.now();
        }
      }

      const registry = new AgentRegistry(store);
      await registry.boot(config);

      const participants: IAgent[] = [];
      const missingAgents: string[] = [];
      for (const id of stored.participantIds) {
        const agent = registry.get(id);
        if (agent) {
          participants.push(agent);
        } else {
          missingAgents.push(id);
        }
      }

      if (missingAgents.length > 0) {
        console.error(`Agents not available: ${missingAgents.join(', ')}`);
        console.error('Available agents:');
        for (const a of registry.list()) {
          console.error(`  ${a.id} — ${a.name} [${a.type}]`);
        }
        await registry.shutdown();
        process.exit(1);
      }

      const moderatorAgent = registry.get(options.moderator ?? stored.moderatorId);
      const moderatorId = moderatorAgent ? (options.moderator ?? stored.moderatorId) : config.meetings.defaultModerator;

      console.log('╔══════════════════════════════════════════════╗');
      console.log('║       AGENT MEETINGS — Resume Session        ║');
      console.log('╠══════════════════════════════════════════════╣');
      console.log(`║ Meeting: ${padRight(stored.id.slice(0, 32), 32)} ║`);
      console.log(`║ Topic: ${padRight(stored.topic.slice(0, 36), 36)} ║`);
      console.log(`║ Resuming from: ${padRight(stored.currentPhase ?? 'unknown', 30)} ║`);
      console.log(`║ Transcript: ${padRight(String(stored.transcript.length) + ' messages', 30)} ║`);
      console.log('╠══════════════════════════════════════════════╣');
      console.log('║ Participants:                                 ║');
      for (const p of participants) {
        const label = `${p.name} (${p.type})`;
        console.log(`║   • ${padRight(label, 40)} ║`);
      }
      console.log(`║ Moderator: ${padRight(moderatorAgent?.name ?? moderatorId, 35)} ║`);
      if (stored.config?.workDir) {
        console.log(`║ WorkDir: ${padRight(stored.config.workDir, 35)} ║`);
      }
      console.log('╚══════════════════════════════════════════════╝');
      console.log();

      const engine = MeetingEngine.fromStoredMeeting(stored, participants, {
        defaultLLM: registry.getLLMAdapter(moderatorId) ?? undefined,
        checkpointStore: store,
        context: options.context ?? undefined,
        moderatorId: options.moderator ?? undefined,
        speakerOrder: parseIds(options.speakerOrder),
        maxRebuttalRounds: options.rebuttalRounds ? parseInt(options.rebuttalRounds, 10) : undefined,
        maxDeliberationRounds: options.deliberationRounds ? parseInt(options.deliberationRounds, 10) : undefined,
        maxPlanRounds: options.planRounds ? parseInt(options.planRounds, 10) : undefined,
        maxBuildRounds: parseInt(options.buildRounds, 10),
        maxReviewRounds: options.reviewRounds ? parseInt(options.reviewRounds, 10) : undefined,
        maxTotalRounds: options.totalRounds ? parseInt(options.totalRounds, 10) : undefined,
        onTurnStart: (name) => {
          if (stream) {
            process.stdout.write(`  ⏳ Waiting for ${name}...`);
          }
        },
        onTurnEnd: (name) => {
          if (stream) {
            process.stdout.write('\r\x1b[K');
          }
        },
      });

      const phaseLabels: Record<string, string> = {
        opening: 'OPENING — topic introduction',
        position: 'POSITION — agents state their views',
        rebuttal: 'REBUTTAL — agents respond to each other',
        deliberation: 'DELIBERATION — free-form discussion',
        voting: 'VOTING — casting votes',
        plan: 'PLAN — agents propose approach',
        build: 'BUILD — agents implement',
        review: 'REVIEW — agents review output',
        wrapup: 'WRAP-UP — final positions',
        summary: 'SUMMARY — final recap',
        concluded: 'CONCLUDED',
      };

      let lastPhase = stored.currentPhase ?? '';
      const stream = options.stream !== false;

      if (stream) {
        const origPush = engine.transcript.push.bind(engine.transcript);
        engine.transcript.push = function (msg) {
          if (msg.phase !== lastPhase) {
            lastPhase = msg.phase;
            console.log(`\n─ ${phaseLabels[msg.phase] ?? msg.phase} ─`.padEnd(50, '─'));
          }

          const prefix = msg.authorId === '__system_moderator__' ? '◆' : '◇';
          const time = new Date(msg.timestamp).toLocaleTimeString();
          console.log(`  ${prefix} [${time}] ${msg.authorName}:`);

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
        try {
          const finalStored = engine.toStoredMeeting();
          await store.saveMeeting(finalStored);

          const logPath = join(config.server.dataDir, 'meetings', `${engine.id}.log`);
          mkdirSync(join(config.server.dataDir, 'meetings'), { recursive: true });
          writeFileSync(logPath, formatLog(engine), 'utf-8');

          console.log(`\nMeeting record updated:`);
          console.log(`  JSON: ${join(config.server.dataDir, 'meetings', `${engine.id}.json`)}`);
          console.log(`  Log:  ${logPath}`);
        } catch (e) {
          console.error('Failed to save meeting record:', (e as Error).message);
        }
        await registry.shutdown();
      }

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
