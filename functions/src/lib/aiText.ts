/**
 * Clinical free-text generation with Gemini on Vertex AI (summaries, handoffs,
 * IDG prep). Reuses the GEMINI_MODEL / VERTEX_LOCATION params and the client
 * pattern from `lib/gemini.ts`; data stays inside the project's Google Cloud
 * boundary (Vertex AI, covered by the Google Cloud BAA).
 *
 * Logging rule: only error codes and HTTP statuses are logged — never prompts,
 * model output or API error messages, because any of them can contain PHI.
 */
import { GoogleGenAI } from '@google/genai';
import { HttpsError, type FunctionsErrorCode } from 'firebase-functions/v2/https';
import { GEMINI_MODEL, VERTEX_LOCATION } from './gemini';

/** Shown with (and stored alongside) every AI output. */
export const AI_DISCLAIMER = 'AI-generated summary — verify against the chart before acting.';

/** Shared rules for every clinical prompt. */
export const CLINICAL_SYSTEM_RULES = `You are a documentation assistant for a hospice interdisciplinary team. Your readers are licensed clinicians.

Rules:
- Use ONLY the information provided in the input. Never invent, infer or assume facts, values, medications, doses, times, diagnoses or plans that are not stated.
- Be concise and factual. Prefer short bullet points. No greetings, no filler, no speculation.
- When information is missing, ambiguous or conflicting, say so explicitly (e.g. "Unclear:", "Not documented:") instead of guessing.
- Keep clinical terms and numbers exactly as written in the input.
- Do not give new medical advice or recommend treatments that the input does not mention.
- Refer to team members by the names given in the input.
- Output plain text (simple "-" bullets and short headings are fine). Do not output a disclaimer; the app adds one.`;

export interface TextGenerationInput {
  systemInstruction: string;
  prompt: string;
  maxOutputTokens?: number;
}

export interface TextGenerationOutput {
  text: string;
  model: string;
}

/** Injectable so tests can supply a fake. */
export interface TextGenerator {
  generate(input: TextGenerationInput): Promise<TextGenerationOutput>;
}

/** Error with a PHI-free code and user-facing message. */
export class AiTextError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = 'AiTextError';
  }
}

export class VertexTextGenerator implements TextGenerator {
  private client: GoogleGenAI | null = null;

  constructor(private readonly opts: { project?: string; location?: string; model?: string } = {}) {}

  private getClient(): GoogleGenAI {
    if (!this.client) {
      const project = this.opts.project ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
      if (!project) throw new AiTextError('no_project', 'AI is not configured for this project.');
      this.client = new GoogleGenAI({ vertexai: true, project, location: this.opts.location ?? VERTEX_LOCATION.value() });
    }
    return this.client;
  }

  async generate(input: TextGenerationInput): Promise<TextGenerationOutput> {
    const model = this.opts.model ?? GEMINI_MODEL.value();
    const response = await this.getClient().models.generateContent({
      model,
      contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
      config: {
        systemInstruction: input.systemInstruction,
        temperature: 0.2,
        maxOutputTokens: input.maxOutputTokens ?? 2048,
      },
    });
    const text = response.text?.trim();
    if (!text) throw new AiTextError('model_empty', 'The AI service returned no output. Try again.');
    return { text, model };
  }
}

let defaultGenerator: TextGenerator | null = null;
export function getDefaultTextGenerator(): TextGenerator {
  defaultGenerator ??= new VertexTextGenerator();
  return defaultGenerator;
}

export interface DescribedAiError {
  code: FunctionsErrorCode;
  publicMessage: string;
  /** Safe to log: codes and statuses only. */
  logFields: Record<string, unknown>;
}

/**
 * Maps a generation failure to a callable error code, a user-facing message
 * and PHI-free log fields (same status mapping as `describeExtractionError`,
 * but the API error message is not logged).
 */
export function describeAiError(e: unknown): DescribedAiError {
  if (e instanceof AiTextError) return { code: 'unavailable', publicMessage: e.publicMessage, logFields: { code: e.code } };
  const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : null;
  if (status !== null) {
    const logFields = { code: 'vertex_api_error', status };
    if (status === 401 || status === 403) {
      return {
        code: 'failed-precondition',
        logFields,
        publicMessage:
          'AI is not set up: the Cloud Functions service account lacks Vertex AI access (roles/aiplatform.user) or the Vertex AI API is disabled. Ask your admin to fix the setup.',
      };
    }
    if (status === 404) {
      return {
        code: 'failed-precondition',
        logFields,
        publicMessage: 'AI is not set up: the configured Gemini model (GEMINI_MODEL) is not available in VERTEX_LOCATION. Ask your admin to fix the setup.',
      };
    }
    if (status === 429) return { code: 'resource-exhausted', logFields, publicMessage: 'The AI service is busy (quota exceeded). Retry in a minute.' };
    if (status === 400) return { code: 'invalid-argument', logFields, publicMessage: 'The AI service rejected the request (the input may be too large). Try a shorter time range.' };
    return { code: 'unavailable', logFields, publicMessage: `The AI service returned an error (${status}). Try again.` };
  }
  return { code: 'internal', publicMessage: 'AI generation failed. Try again.', logFields: { code: (e as Error)?.name ?? 'unknown' } };
}

/** True for errors that will fail every subsequent call too (setup/quota), so batch loops should stop. */
export function isFatalAiError(e: unknown): boolean {
  const status = (e as { status?: unknown })?.status;
  return status === 401 || status === 403 || status === 404 || status === 429;
}

export function toHttpsError(d: DescribedAiError): HttpsError {
  return new HttpsError(d.code, d.publicMessage);
}
