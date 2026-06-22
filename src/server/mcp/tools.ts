import type { AgentRegistry } from '../agent-registry.js';
import type { DataStore } from '../../persistence/types.js';
import type { Config } from '../../config/types.js';
import type { IAgent } from '../../agent/types.js';
import { MeetingEngine } from '../../meeting/engine.js';
import type { RunningMeeting } from '../http-routes.js';
import {
  createMeetingSchema,
  listMeetingsSchema,
  getMeetingSchema,
  cancelMeetingSchema,
  resumeMeetingSchema,
  getAgentSchema,
} from './types.js';
import type {
  CreateMeetingInput,
  ListMeetingsInput,
  GetMeetingInput,
  CancelMeetingInput,
  ResumeMeetingInput,
  GetAgentInput,
} from './types.js';

export interface ToolContext {
  registry: AgentRegistry;
  store: DataStore;
  config: Config;
  meetings: Map<string, RunningMeeting>;
}

async function handleCreateMeeting(input: CreateMeetingInput, ctx: ToolContext) {
  const participants = input.participantIds
    .map((id) => ctx.registry.get(id))
    .filter((a): a is IAgent => a != null);

  if (participants.length === 0) {
    return { content: [{ type: 'text' as const, text: 'Error: No available participants found' }], isError: true };
  }

  const moderatorId = input.moderatorId ?? ctx.config.meetings.defaultModerator;

  const engine = new MeetingEngine({
    topic: input.topic,
    context: input.context ?? '',
    participants,
    moderatorId,
    mode: input.mode ?? ctx.config.meetings.mode,
    speakerOrder: input.speakerOrder ?? ctx.config.meetings.speakerOrder,
    workDir: input.workDir,
    turnTimeoutMs: input.turnTimeoutMs ?? ctx.config.meetings.turnTimeoutMs,
    maxRebuttalRounds: input.maxRebuttalRounds ?? ctx.config.meetings.maxRebuttalRounds,
    maxDeliberationRounds: input.maxDeliberationRounds ?? ctx.config.meetings.maxDeliberationRounds,
    maxPlanRounds: input.maxPlanRounds ?? ctx.config.meetings.maxPlanRounds,
    maxBuildRounds: input.maxBuildRounds ?? ctx.config.meetings.maxBuildRounds,
    maxReviewRounds: input.maxReviewRounds ?? ctx.config.meetings.maxReviewRounds,
    maxTotalRounds: input.maxTotalRounds ?? ctx.config.meetings.maxTotalRounds,
    defaultLLM: ctx.registry.getLLMAdapter(moderatorId) ?? undefined,
    checkpointStore: ctx.store,
  });

  await ctx.store.saveMeeting(engine.toStoredMeeting());

  const running: RunningMeeting = { engine, running: null };
  ctx.meetings.set(engine.id, running);

  const autoStart = input.autoStart !== false;
  if (autoStart) {
    running.running = engine.start().catch(() => {});
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        id: engine.id,
        topic: engine.topic,
        status: engine.status,
        mode: engine.mode,
        participantIds: engine.participantIds,
      }, null, 2),
    }],
  };
}

async function handleListMeetings(input: ListMeetingsInput, ctx: ToolContext) {
  const list = await ctx.store.listMeetings(
    input.status ? { status: input.status } : undefined
  );
  const result = (input.limit ? list.slice(0, input.limit) : list).map((m) => ({
    id: m.id,
    topic: m.topic,
    status: m.status,
    phase: m.currentPhase,
    mode: m.mode ?? 'debate',
    participantIds: m.participantIds,
    moderatorId: m.moderatorId,
    createdAt: m.createdAt,
    concludedAt: m.concludedAt ?? null,
    transcriptLength: m.transcript.length,
  }));

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

async function handleGetMeeting(input: GetMeetingInput, ctx: ToolContext) {
  const running = ctx.meetings.get(input.id);
  if (running) {
    const stored = running.engine.toStoredMeeting();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(stored, null, 2) }],
    };
  }

  const meeting = await ctx.store.getMeeting(input.id);
  if (!meeting) {
    return { content: [{ type: 'text' as const, text: `Meeting "${input.id}" not found` }], isError: true };
  }

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(meeting, null, 2) }],
  };
}

async function handleCancelMeeting(input: CancelMeetingInput, ctx: ToolContext) {
  const running = ctx.meetings.get(input.id);
  if (running) {
    running.engine.cancel();
    await ctx.store.saveMeeting(running.engine.toStoredMeeting());
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ id: input.id, status: 'cancelled' }) }],
    };
  }

  const stored = await ctx.store.getMeeting(input.id);
  if (!stored) {
    return { content: [{ type: 'text' as const, text: `Meeting "${input.id}" not found` }], isError: true };
  }
  stored.status = 'cancelled';
  await ctx.store.saveMeeting(stored);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ id: input.id, status: 'cancelled' }) }],
  };
}

async function handleResumeMeeting(input: ResumeMeetingInput, ctx: ToolContext) {
  if (ctx.meetings.has(input.id)) {
    return { content: [{ type: 'text' as const, text: 'Error: Meeting is already running' }], isError: true };
  }

  const stored = await ctx.store.getMeeting(input.id);
  if (!stored) {
    return { content: [{ type: 'text' as const, text: `Meeting "${input.id}" not found` }], isError: true };
  }
  if (stored.status !== 'active' && stored.status !== 'concluded') {
    return {
      content: [{ type: 'text' as const, text: `Error: Meeting status is "${stored.status}". Only active or concluded meetings can be resumed.` }],
      isError: true,
    };
  }

  const participantIds = input.participantIds ?? stored.participantIds;
  const participants = participantIds
    .map((pid) => ctx.registry.get(pid))
    .filter((a): a is IAgent => a != null);

  if (participants.length === 0) {
    return { content: [{ type: 'text' as const, text: 'Error: No available participants found' }], isError: true };
  }

  const engine = MeetingEngine.fromStoredMeeting(stored, participants, {
    defaultLLM: ctx.registry.getLLMAdapter(stored.moderatorId) ?? undefined,
    checkpointStore: ctx.store,
    workDir: input.workDir,
    context: input.context,
    mode: input.mode,
    speakerOrder: input.speakerOrder,
    turnTimeoutMs: input.turnTimeoutMs,
    maxRebuttalRounds: input.maxRebuttalRounds,
    maxDeliberationRounds: input.maxDeliberationRounds,
    maxPlanRounds: input.maxPlanRounds,
    maxBuildRounds: input.maxBuildRounds,
    maxReviewRounds: input.maxReviewRounds,
    maxTotalRounds: input.maxTotalRounds,
  });

  const running: RunningMeeting = { engine, running: null };
  ctx.meetings.set(engine.id, running);
  running.running = engine.start().catch(() => {});

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        id: engine.id,
        topic: engine.topic,
        status: 'active',
        transcriptLength: stored.transcript.length,
      }, null, 2),
    }],
  };
}

async function handleListAgents(_input: Record<string, never>, ctx: ToolContext) {
  const agents = ctx.registry.list().map((a) => ({
    id: a.id,
    name: a.name,
    capabilities: a.capabilities,
    type: a.type,
    supportsVision: a.supportsVision ?? false,
  }));
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(agents, null, 2) }],
  };
}

async function handleGetAgent(input: GetAgentInput, ctx: ToolContext) {
  const agent = ctx.registry.get(input.id);
  if (!agent) {
    return { content: [{ type: 'text' as const, text: `Agent "${input.id}" not found` }], isError: true };
  }
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        id: agent.id,
        name: agent.name,
        capabilities: agent.capabilities,
        type: agent.type,
        supportsVision: agent.supportsVision ?? false,
      }, null, 2),
    }],
  };
}

export function registerAllTools(
  server: import('@modelcontextprotocol/sdk/server/mcp.js').McpServer,
  ctx: ToolContext
): void {
  server.registerTool(
    'create_meeting',
    { description: 'Create and start a new agent meeting', inputSchema: createMeetingSchema.shape },
    async (args) => handleCreateMeeting(args as unknown as CreateMeetingInput, ctx)
  );

  server.registerTool(
    'list_meetings',
    { description: 'List meetings, optionally filtered by status', inputSchema: listMeetingsSchema.shape },
    async (args) => handleListMeetings(args as unknown as ListMeetingsInput, ctx)
  );

  server.registerTool(
    'get_meeting',
    { description: 'Get full meeting details including transcript', inputSchema: getMeetingSchema.shape },
    async (args) => handleGetMeeting(args as unknown as GetMeetingInput, ctx)
  );

  server.registerTool(
    'cancel_meeting',
    { description: 'Cancel a running meeting', inputSchema: cancelMeetingSchema.shape },
    async (args) => handleCancelMeeting(args as unknown as CancelMeetingInput, ctx)
  );

  server.registerTool(
    'resume_meeting',
    { description: 'Resume an interrupted or concluded meeting', inputSchema: resumeMeetingSchema.shape },
    async (args) => handleResumeMeeting(args as unknown as ResumeMeetingInput, ctx)
  );

  server.registerTool(
    'get_server_info',
    {
      description: 'Get server connection info (WebSocket URL, auth token) for remote agent access',
      inputSchema: {},
    },
    async () => ({
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          host: ctx.config.server.host,
          port: ctx.config.server.port,
          wsToken: ctx.config.server.wsToken ?? '(randomly generated at startup)',
          wsUrl: `ws://${ctx.config.server.host === '0.0.0.0' ? 'localhost' : ctx.config.server.host}:${ctx.config.server.port}/ws`,
          connectCommand: `am connect --server ws://${ctx.config.server.host === '0.0.0.0' ? 'localhost' : ctx.config.server.host}:${ctx.config.server.port} --token <token> --id <agent-id> --name "<Agent Name>"`,
        }, null, 2),
      }],
    })
  );

  server.registerTool(
    'list_agents',
    { description: 'List all registered agents with their capabilities', inputSchema: {} },
    async () => handleListAgents({} as Record<string, never>, ctx)
  );

  server.registerTool(
    'get_agent',
    { description: 'Get details for a specific agent', inputSchema: getAgentSchema.shape },
    async (args) => handleGetAgent(args as unknown as GetAgentInput, ctx)
  );
}
