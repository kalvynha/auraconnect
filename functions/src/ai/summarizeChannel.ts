/**
 * `summarizeChannel` — Gemini summary of a channel's recent messages. The
 * result is returned to the caller only (never stored). Any channel member may
 * call it, including viewers.
 */
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { writeAudit } from '../lib/audit';
import { AI_DISCLAIMER, CLINICAL_SYSTEM_RULES } from '../lib/aiText';
import { parse, requireOrg } from '../lib/context';
import { getDocData, paths } from '../lib/db';
import { id } from '../lib/schemas';
import type { AiTextResult, Channel, Org, SummarizeChannelRequest } from '../shared/types';
import { formatMessages, MAX_AI_MESSAGES } from './format';
import { loadChannelMessages } from './patientActivity';
import { generateOrThrow, type AiDeps } from './run';

export const DEFAULT_SUMMARY_HOURS = 24;

const schema = z.object({
  orgId: id,
  channelId: id,
  sinceHours: z.number().int().min(1).max(720).default(DEFAULT_SUMMARY_HOURS),
});

export const SUMMARY_SYSTEM_PROMPT = `${CLINICAL_SYSTEM_RULES}

Task: summarize a hospice team chat transcript for a clinician who was not following it.
Structure:
- Key updates (patient condition changes, symptoms, visits, medications as stated)
- Decisions made
- Open questions / follow-ups (with who owns them, if stated)
- Urgent items (anything marked URGENT/CRITICAL or describing acute symptoms)
Omit sections that have nothing to report. Never add information that is not in the transcript.`;

export async function summarizeChannelHandler(request: CallableRequest<SummarizeChannelRequest>, deps: AiDeps = {}): Promise<AiTextResult> {
  const input = parse(schema, request.data);
  const ctx = await requireOrg(request, input.orgId);

  const channel = await getDocData<Channel>(paths.channel(ctx.orgId, input.channelId));
  if (!channel) throw new HttpsError('not-found', 'Channel not found.');
  if (!channel.memberUids?.includes(ctx.uid)) throw new HttpsError('permission-denied', 'You are not a member of this channel.');

  const org = await getDocData<Org>(paths.org(ctx.orgId));
  const tz = org?.timezone ?? 'UTC';
  const sinceMs = Date.now() - input.sinceHours * 3_600_000;
  const messages = await loadChannelMessages(ctx.orgId, input.channelId, sinceMs, MAX_AI_MESSAGES);

  let result: AiTextResult;
  if (messages.length === 0) {
    result = { text: `No messages in the last ${input.sinceHours} hours.`, model: 'none', disclaimer: AI_DISCLAIMER };
  } else {
    const prompt =
      `Channel: ${channel.type === 'direct' ? 'direct conversation' : (channel.name ?? 'unnamed channel')}\n` +
      `Time zone: ${tz}. Window: last ${input.sinceHours} hours (${messages.length} messages${messages.length >= MAX_AI_MESSAGES ? ', older messages omitted' : ''}).\n\n` +
      `Transcript:\n${formatMessages(messages, tz)}`;
    const out = await generateOrThrow(deps, 'summarizeChannel', ctx.orgId, { systemInstruction: SUMMARY_SYSTEM_PROMPT, prompt, maxOutputTokens: 1024 });
    result = { text: out.text, model: out.model, disclaimer: AI_DISCLAIMER };
  }

  await writeAudit(ctx.orgId, {
    actorUid: ctx.uid,
    action: 'ai.summarize_channel',
    resourceType: 'channel',
    resourceId: input.channelId,
    patientId: channel.patientId ?? null,
    metadata: { model: result.model, messages: messages.length, sinceHours: input.sinceHours },
  });
  return result;
}

export const summarizeChannel = onCall({ timeoutSeconds: 120 }, (req: CallableRequest<SummarizeChannelRequest>) => summarizeChannelHandler(req));
