/** Shared call wrapper for the AI callables: prompt cap, PHI-free error logging, error mapping. */
import { logger } from 'firebase-functions/v2';
import { describeAiError, getDefaultTextGenerator, toHttpsError, type TextGenerationOutput, type TextGenerator } from '../lib/aiText';
import { capPrompt } from './format';

export interface AiDeps {
  generator?: TextGenerator;
}

/**
 * Runs one generation. On failure logs only `{ feature, orgId, code, status }`
 * and throws an HttpsError with a user-facing message.
 */
export async function generateOrThrow(
  deps: AiDeps,
  feature: string,
  orgId: string,
  input: { systemInstruction: string; prompt: string; maxOutputTokens?: number },
): Promise<TextGenerationOutput> {
  try {
    return await (deps.generator ?? getDefaultTextGenerator()).generate({ ...input, prompt: capPrompt(input.prompt) });
  } catch (e) {
    const d = describeAiError(e);
    logger.error('ai generation failed', { feature, orgId, ...d.logFields });
    throw toHttpsError(d);
  }
}
