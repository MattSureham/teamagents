import type { IncomingMessage, ServerResponse } from 'node:http';
import type { EventEmitter } from 'node:events';
import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, extname, resolve, sep } from 'node:path';
import type { AgentRegistry } from './agent-registry.js';
import type { DataStore } from '../persistence/types.js';
import { MeetingEngine } from '../meeting/engine.js';
import { formatLog } from '../meeting/format-log.js';
import type { Config } from '../config/types.js';
import type { IAgent } from '../agent/types.js';
import { parseInlineContext } from '../utils/context-loader.js';
import { setupMCP } from './mcp/index.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const UI_DIR = join(import.meta.dirname, '..', '..', 'public');

export interface RunningMeeting {
  engine: MeetingEngine;
  running: Promise<void> | null;
}

interface CreateMeetingBody {
  topic: string;
  context?: string;
  contextImages?: { data: string; mimeType: string }[];
  participantIds: string[];
  moderatorId?: string;
  autoStart?: boolean;
  mode?: 'debate' | 'collaboration';
  workDir?: string;
  maxPlanRounds?: number;
  maxBuildRounds?: number;
  maxReviewRounds?: number;
}

interface CreateAgentBody {
  id: string;
  name: string;
  capabilities?: string[];
  type?: string;
}

export function createRouter(
  registry: AgentRegistry,
  store: DataStore,
  config: Config,
  events: EventEmitter
) {
  const meetings: Map<string, RunningMeeting> = new Map();

  // Detect interrupted meetings from a previous server run
  store.listMeetings({ status: 'active' }).then((active) => {
    if (active.length > 0) {
      console.log(`Found ${active.length} interrupted meeting(s) from previous run:`);
      for (const m of active) {
        console.log(`  ${m.id} — "${m.topic}" [was in phase: ${m.currentPhase}]`);
      }
      console.log('Use POST /meetings/:id/resume to resume an interrupted meeting.');
    }
  }).catch(() => {});

  const mcp = setupMCP(registry, store, config, meetings);

  const router = async function router(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      // Static file serving for the web UI
      if (method === 'GET' && (path === '/' || path === '/ui' || path.startsWith('/ui/'))) {
        let filePath = path === '/' || path === '/ui' ? '/index.html' : path.replace('/ui', '');
        const fullPath = join(UI_DIR, filePath);
        if (existsSync(fullPath)) {
          const ext = extname(fullPath);
          res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream' });
          res.end(readFileSync(fullPath));
        } else {
          json(res, 404, { error: 'File not found' });
        }
        return;
      }

      // MCP endpoint (SSE transport)
      if (path === '/mcp' && (method === 'GET' || method === 'POST')) {
        await mcp.handleSSE(req, res);
        return;
      }

      if (method === 'GET' && path === '/fs/ls') {
        const dirPath = url.searchParams.get('path') || process.cwd();
        try {
          const resolved = resolve(dirPath);
          const entries = readdirSync(resolved, { withFileTypes: true });
          const dirs = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => ({ name: e.name, path: join(resolved, e.name) }));
          const parent = resolved.split(sep).slice(0, -1).join(sep) || sep;
          return json(res, 200, { current: resolved, parent, dirs });
        } catch {
          return json(res, 400, { error: 'Cannot read directory' });
        }
      }

      if (method === 'POST' && path === '/fs/mkdir') {
        const body = await readBody<{ parent: string; name: string }>(req);
        if (!body.parent || !body.name || body.name.includes('/') || body.name.includes('\\')) {
          return json(res, 400, { error: 'parent and a valid name are required' });
        }
        try {
          const newPath = join(resolve(body.parent), body.name);
          mkdirSync(newPath);
          return json(res, 201, { path: newPath });
        } catch {
          return json(res, 400, { error: 'Cannot create directory' });
        }
      }

      if (method === 'GET' && path === '/health') {
        return json(res, 200, {
          status: 'ok',
          uptime: process.uptime(),
          agents: registry.list().length,
          activeMeetings: [...meetings.values()].filter(
            (m) => m.engine.status === 'active'
          ).length,
        });
      }

      if (method === 'GET' && path === '/agents') {
        return json(
          res,
          200,
          registry.list().map((a) => ({
            id: a.id,
            name: a.name,
            capabilities: a.capabilities,
            type: a.type,
          }))
        );
      }

      if (method === 'POST' && path === '/agents') {
        const body = await readBody<CreateAgentBody>(req);
        const agent = await store.saveAgent({
          id: body.id,
          name: body.name,
          capabilities: body.capabilities ?? [],
          type: body.type === 'subprocess' || body.type === 'llm' || body.type === 'protocol'
            ? body.type
            : 'protocol',
          status: 'online',
          lastHeartbeat: Date.now(),
          registeredAt: Date.now(),
        });
        return json(res, 201, agent);
      }

      if (method === 'DELETE' && path.startsWith('/agents/')) {
        const id = path.slice('/agents/'.length);
        await registry.unregister(id);
        return json(res, 200, { removed: id });
      }

      if (method === 'GET' && path === '/meetings') {
        const status = url.searchParams.get('status');
        const limit = parseInt(url.searchParams.get('limit') ?? '', 10) || 0;
        const list = await store.listMeetings(
          status
            ? { status: status as 'active' | 'concluded' | 'pending' | 'cancelled' }
            : undefined
        );
        return json(res, 200, limit > 0 ? list.slice(0, limit) : list);
      }

      if (method === 'POST' && path === '/meetings') {
        const body = await readBody<CreateMeetingBody>(req);

        if (!body.topic || !body.participantIds?.length) {
          return json(res, 400, { error: 'topic and participantIds are required' });
        }

        const participants = body.participantIds
          .map((id) => registry.get(id))
          .filter((a): a is IAgent => a != null);

        if (participants.length === 0) {
          return json(res, 400, { error: 'No available participants found' });
        }

        const moderatorId = body.moderatorId ?? config.meetings.defaultModerator;

        // Process context for inline data URIs (images, PDFs, DOCX from web UI uploads)
        let contextText = body.context ?? '';
        let contextImages = body.contextImages ?? [];
        if (contextText.includes('data:')) {
          const parsed = await parseInlineContext(contextText);
          contextText = parsed.text;
          // Merge server-processed images with any client-sent ones
          if (parsed.images.length > 0) {
            contextImages = [...contextImages, ...parsed.images];
          }
        }

        const engine = new MeetingEngine({
          topic: body.topic,
          context: contextText,
          contextImages: contextImages.length > 0 ? contextImages : undefined,
          participants,
          moderatorId,
          mode: body.mode ?? config.meetings.mode,
          workDir: body.workDir,
          turnTimeoutMs: config.meetings.turnTimeoutMs,
          maxRebuttalRounds: config.meetings.maxRebuttalRounds,
          maxDeliberationRounds: config.meetings.maxDeliberationRounds,
          maxPlanRounds: body.maxPlanRounds ?? config.meetings.maxPlanRounds,
          maxBuildRounds: body.maxBuildRounds ?? config.meetings.maxBuildRounds,
          maxReviewRounds: body.maxReviewRounds ?? config.meetings.maxReviewRounds,
          defaultLLM: registry.getLLMAdapter(moderatorId) ?? undefined,
          checkpointStore: store,
          onTranscript: (msg) => events.emit('transcript', engine.id, msg),
          onPhaseChange: (phase) => events.emit('phase', engine.id, phase),
          onStatusChange: (status) => events.emit('status', engine.id, status),
          onTurnStart: (name) => events.emit('turn_start', engine.id, name),
          onTurnEnd: (name) => events.emit('turn_end', engine.id, name),
        });

        await store.saveMeeting(engine.toStoredMeeting());

        const running: RunningMeeting = { engine, running: null };
        meetings.set(engine.id, running);

        const autoStart = body.autoStart !== false;
        if (autoStart) {
          running.running = engine.start().then(() => {
            meetings.delete(engine.id);
            store.saveMeeting(engine.toStoredMeeting()).catch(() => {});
            saveMeetingLog(config.server.dataDir, engine);
          });
        }

        return json(res, 201, { id: engine.id, topic: engine.topic, status: engine.status });
      }

      if (method === 'GET' && path.startsWith('/meetings/') && path.endsWith('/log')) {
        const id = path.slice('/meetings/'.length).replace('/log', '');
        const logPath = join(config.server.dataDir, 'meetings', `${id}.log`);
        // Prefer pre-written log file, but generate on-the-fly for active meetings
        if (existsSync(logPath)) {
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end(readFileSync(logPath, 'utf-8'));
        } else {
          const running = meetings.get(id);
          if (running) {
            res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
            res.end(formatLog(running.engine));
          } else {
            json(res, 404, { error: 'Meeting log not found' });
          }
        }
        return;
      }

      if (method === 'GET' && path.startsWith('/meetings/')) {
        const id = path.slice('/meetings/'.length);
        if (id === 'active') {
          const active = [...meetings.values()].filter(
            (m) => m.engine.status === 'active'
          );
          return json(
            res,
            200,
            active.map((m) => ({
              id: m.engine.id,
              topic: m.engine.topic,
              status: m.engine.status,
              phase: m.engine.currentPhase,
            }))
          );
        }

        const meeting = await store.getMeeting(id);

        // If the meeting is currently running, return live state from engine
        const running = meetings.get(id);
        if (running) {
          const stored = running.engine.toStoredMeeting();
          if (meeting) stored.summary = stored.summary ?? meeting.summary;
          return json(res, 200, stored);
        }

        if (!meeting) return json(res, 404, { error: 'Meeting not found' });
        return json(res, 200, meeting);
      }

      if (method === 'POST' && path.startsWith('/meetings/') && path.endsWith('/start')) {
        const id = path.slice('/meetings/'.length).replace('/start', '');
        const stored = await store.getMeeting(id);
        if (!stored) return json(res, 404, { error: 'Meeting not found' });
        if (stored.status !== 'pending') {
          return json(res, 400, { error: `Meeting is ${stored.status}, not pending` });
        }

        const participants = stored.participantIds
          .map((pid) => registry.get(pid))
          .filter((a): a is IAgent => a != null);

        const engine = new MeetingEngine({
          topic: stored.topic,
          context: stored.context,
          contextImages: stored.contextImages,
          participants,
          moderatorId: stored.moderatorId,
          turnTimeoutMs: config.meetings.turnTimeoutMs,
          maxRebuttalRounds: config.meetings.maxRebuttalRounds,
          maxDeliberationRounds: config.meetings.maxDeliberationRounds,
          maxPlanRounds: config.meetings.maxPlanRounds,
          maxBuildRounds: config.meetings.maxBuildRounds,
          maxReviewRounds: config.meetings.maxReviewRounds,
          defaultLLM: registry.getLLMAdapter(stored.moderatorId) ?? undefined,
          resumeId: stored.id,
          checkpointStore: store,
          onTranscript: (msg) => events.emit('transcript', engine.id, msg),
          onPhaseChange: (phase) => events.emit('phase', engine.id, phase),
          onStatusChange: (status) => events.emit('status', engine.id, status),
          onTurnStart: (name) => events.emit('turn_start', engine.id, name),
          onTurnEnd: (name) => events.emit('turn_end', engine.id, name),
        });

        const running: RunningMeeting = { engine, running: null };
        meetings.set(engine.id, running);
        engine.status = 'active';
        running.running = engine.start().then(() => {
          store.saveMeeting(engine.toStoredMeeting()).catch(() => {});
          saveMeetingLog(config.server.dataDir, engine);
        });

        return json(res, 200, { id: engine.id, status: 'active' });
      }

      if (method === 'POST' && path.startsWith('/meetings/') && path.endsWith('/resume')) {
        const id = path.slice('/meetings/'.length).replace('/resume', '');
        const body = await readBody<{
          workDir?: string;
          context?: string;
          participantIds?: string[];
          moderatorId?: string;
          mode?: 'debate' | 'collaboration';
          maxPlanRounds?: number;
          maxBuildRounds?: number;
          maxReviewRounds?: number;
        }>(req);

        if (meetings.has(id)) {
          return json(res, 409, { error: 'Meeting is already running' });
        }

        const stored = await store.getMeeting(id);
        if (!stored) return json(res, 404, { error: 'Meeting not found' });
        if (stored.status !== 'active' && stored.status !== 'concluded') {
          return json(res, 400, {
            error: `Meeting status is "${stored.status}". Only active or concluded meetings can be resumed.`,
          });
        }

        const isContinuation = stored.status === 'concluded';

        // For concluded meetings, jump to an open discussion phase so agents
        // can dive deeper with full prior transcript as context.
        if (isContinuation) {
          const contPhase = (body.mode ?? stored.mode) === 'collaboration' ? 'plan' : 'deliberation';
          stored.currentPhase = contPhase;
          // Clear the resume point so we start fresh from this phase
          stored.resumePoint = undefined;
          // Keep the transcript, phaseTimeline through the vote/summary,
          // but mark the final timeline entries as exited so the engine
          // enters the continuation phase cleanly.
          if (stored.phaseTimeline.length > 0) {
            stored.phaseTimeline[stored.phaseTimeline.length - 1].exitedAt = Date.now();
          }
        }

        // Use provided participant IDs or fall back to stored ones
        const participantIds = body.participantIds ?? stored.participantIds;
        const participants = participantIds
          .map((pid) => registry.get(pid))
          .filter((a): a is IAgent => a != null);

        const missingAgents = participantIds.filter((pid) => !registry.get(pid));
        if (missingAgents.length > 0) {
          return json(res, 400, {
            error: `Agents not available: ${missingAgents.join(', ')}`,
            missingAgents,
          });
        }

        if (participants.length === 0) {
          return json(res, 400, { error: 'No available participants found' });
        }

        const effectiveModeratorId = body.moderatorId ?? stored.moderatorId;

        const engine = MeetingEngine.fromStoredMeeting(stored, participants, {
          defaultLLM: registry.getLLMAdapter(effectiveModeratorId) ?? undefined,
          checkpointStore: store,
          workDir: body.workDir ?? undefined,
          context: body.context ?? undefined,
          moderatorId: body.moderatorId ?? undefined,
          mode: body.mode ?? undefined,
          maxPlanRounds: body.maxPlanRounds ?? undefined,
          maxBuildRounds: body.maxBuildRounds ?? undefined,
          maxReviewRounds: body.maxReviewRounds ?? undefined,
          onTranscript: (msg) => events.emit('transcript', engine.id, msg),
          onPhaseChange: (phase) => events.emit('phase', engine.id, phase),
          onStatusChange: (status) => events.emit('status', engine.id, status),
          onTurnStart: (name) => events.emit('turn_start', engine.id, name),
          onTurnEnd: (name) => events.emit('turn_end', engine.id, name),
        });

        const running: RunningMeeting = { engine, running: null };
        meetings.set(engine.id, running);

        running.running = engine.start().then(() => {
          store.saveMeeting(engine.toStoredMeeting()).catch(() => {});
          saveMeetingLog(config.server.dataDir, engine);
        });

        return json(res, 200, {
          id: engine.id,
          topic: engine.topic,
          status: 'active',
          resumedFrom: isContinuation ? stored.currentPhase : stored.currentPhase,
          transcriptLength: stored.transcript.length,
          continuation: isContinuation,
        });
      }

      if (method === 'POST' && path.startsWith('/meetings/') && path.endsWith('/cancel')) {
        const id = path.slice('/meetings/'.length).replace('/cancel', '');
        const running = meetings.get(id);
        if (running) {
          running.engine.cancel();
          await store.saveMeeting(running.engine.toStoredMeeting());
          saveMeetingLog(config.server.dataDir, running.engine);
          return json(res, 200, { id, status: 'cancelled' });
        }

        const stored = await store.getMeeting(id);
        if (!stored) return json(res, 404, { error: 'Meeting not found' });
        stored.status = 'cancelled';
        await store.saveMeeting(stored);
        return json(res, 200, { id, status: 'cancelled' });
      }

      json(res, 404, { error: 'Not found' });
    } catch (e) {
      console.error('Request error:', e);
      json(res, 500, { error: 'Internal server error' });
    }
  };

  router.cancelAllMeetings = () => {
    for (const [id, running] of meetings) {
      running.engine.cancel();
    }
    meetings.clear();
  };

  return router;
}

function saveMeetingLog(dataDir: string, engine: MeetingEngine): void {
  try {
    const dir = join(dataDir, 'meetings');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${engine.id}.log`), formatLog(engine), 'utf-8');
  } catch {
    // best-effort — don't fail the request over log writing
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? (JSON.parse(data) as T) : ({} as T));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
