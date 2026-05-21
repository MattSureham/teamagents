import { z } from 'zod';

export const meetingModeSchema = z.enum(['debate', 'collaboration']);
export const meetingStatusSchema = z.enum(['active', 'concluded', 'pending', 'cancelled']);

export const createMeetingSchema = z.object({
  topic: z.string().min(1).describe('Meeting topic or question to discuss'),
  context: z.string().optional().describe('Additional context or background information'),
  participantIds: z.array(z.string()).min(2).describe('Agent IDs to participate (minimum 2)'),
  moderatorId: z.string().optional().describe('Agent ID to use as moderator'),
  mode: meetingModeSchema.optional().describe('Meeting mode: debate or collaboration'),
  workDir: z.string().optional().describe('Working directory for collaboration meetings'),
  autoStart: z.boolean().optional().describe('Whether to auto-start the meeting (default true)'),
  maxPlanRounds: z.number().int().min(1).max(20).optional(),
  maxBuildRounds: z.number().int().min(1).max(20).optional(),
  maxReviewRounds: z.number().int().min(1).max(20).optional(),
});

export const listMeetingsSchema = z.object({
  status: meetingStatusSchema.optional().describe('Filter meetings by status'),
  limit: z.number().int().min(1).max(100).optional().describe('Maximum number of meetings to return'),
});

export const getMeetingSchema = z.object({
  id: z.string().min(1).describe('Meeting ID'),
});

export const cancelMeetingSchema = z.object({
  id: z.string().min(1).describe('Meeting ID to cancel'),
});

export const resumeMeetingSchema = z.object({
  id: z.string().min(1).describe('Meeting ID to resume'),
  participantIds: z.array(z.string()).optional().describe('Override participant agent IDs'),
  workDir: z.string().optional().describe('Override working directory'),
  context: z.string().optional().describe('Additional context for the continuation'),
});

export const getAgentSchema = z.object({
  id: z.string().min(1).describe('Agent ID'),
});

export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;
export type ListMeetingsInput = z.infer<typeof listMeetingsSchema>;
export type GetMeetingInput = z.infer<typeof getMeetingSchema>;
export type CancelMeetingInput = z.infer<typeof cancelMeetingSchema>;
export type ResumeMeetingInput = z.infer<typeof resumeMeetingSchema>;
export type GetAgentInput = z.infer<typeof getAgentSchema>;
