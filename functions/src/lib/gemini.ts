/**
 * Referral extraction with Gemini on Vertex AI.
 *
 * The file is sent as an inline base64 part (≤ 25 MB, enforced by the caller)
 * with a JSON response schema matching {@link ReferralExtraction}. Vertex's
 * schema subset has no free-form maps, so `fieldConfidence` is requested as an
 * array of `{ path, confidence }` and converted by `normalizeExtraction`.
 * Data stays inside the project's Google Cloud boundary (Vertex AI, covered by
 * the Google Cloud BAA) — do not swap this for the consumer Gemini API.
 */
import { GoogleGenAI, Type, type Schema } from '@google/genai';
import { defineString } from 'firebase-functions/params';

export const GEMINI_MODEL = defineString('GEMINI_MODEL', { default: 'gemini-2.5-flash' });
export const VERTEX_LOCATION = defineString('VERTEX_LOCATION', { default: 'us-central1' });

export interface ExtractorInput {
  data: Buffer;
  mimeType: string;
}

export interface ExtractorOutput {
  /** Raw model JSON (unvalidated); pass through `normalizeExtraction`. */
  raw: unknown;
  model: string;
}

export interface Extractor {
  extract(input: ExtractorInput): Promise<ExtractorOutput>;
}

const nullableString = (description?: string): Schema => ({ type: Type.STRING, nullable: true, description });

const physicianSchema: Schema = {
  type: Type.OBJECT,
  nullable: true,
  properties: {
    name: { type: Type.STRING },
    npi: nullableString('10-digit NPI'),
    phone: nullableString(),
    fax: nullableString(),
  },
  required: ['name'],
};

const diagnosisSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    code: nullableString('ICD-10-CM code exactly as written, e.g. C34.90'),
    description: { type: Type.STRING },
  },
  required: ['description'],
};

export const REFERRAL_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    patient: {
      type: Type.OBJECT,
      properties: {
        firstName: { type: Type.STRING },
        lastName: { type: Type.STRING },
        dob: nullableString('Date of birth as YYYY-MM-DD'),
        sex: { type: Type.STRING, enum: ['female', 'male', 'other', 'unknown'] },
        phone: nullableString(),
        address: {
          type: Type.OBJECT,
          properties: {
            line1: nullableString(),
            line2: nullableString(),
            city: nullableString(),
            state: nullableString('2-letter US state code'),
            zip: nullableString(),
          },
        },
        mrn: nullableString('Medical record number'),
        medicareMbi: nullableString('Medicare Beneficiary Identifier (11 characters)'),
        primaryDiagnosis: { ...diagnosisSchema, nullable: true },
        secondaryDiagnoses: { type: Type.ARRAY, items: diagnosisSchema },
        referringPhysician: physicianSchema,
        attendingPhysician: physicianSchema,
        codeStatus: { type: Type.STRING, enum: ['Full Code', 'DNR', 'DNR/DNI', 'Comfort Care Only', 'Unknown'] },
        allergies: { type: Type.ARRAY, items: { type: Type.STRING } },
        medications: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              dose: nullableString(),
              route: nullableString(),
              frequency: nullableString(),
            },
            required: ['name'],
          },
        },
        caregiver: {
          type: Type.OBJECT,
          nullable: true,
          properties: { name: { type: Type.STRING }, relationship: nullableString(), phone: nullableString() },
          required: ['name'],
        },
        insurance: {
          type: Type.OBJECT,
          properties: { payer: nullableString(), memberId: nullableString() },
        },
      },
      required: ['firstName', 'lastName', 'sex', 'codeStatus'],
    },
    referralDate: nullableString('YYYY-MM-DD'),
    referralSource: nullableString('Referring facility, agency or person'),
    reasonForReferral: nullableString(),
    fieldConfidence: {
      type: Type.ARRAY,
      description: 'Confidence 0-1 for every extracted field, keyed by dotted path such as patient.dob',
      items: {
        type: Type.OBJECT,
        properties: { path: { type: Type.STRING }, confidence: { type: Type.NUMBER } },
        required: ['path', 'confidence'],
      },
    },
    warnings: { type: Type.ARRAY, items: { type: Type.STRING } },
  },
  required: ['patient', 'fieldConfidence', 'warnings'],
};

export const REFERRAL_SYSTEM_PROMPT = `You extract structured data from hospice referral documents (referral forms, H&Ps, face sheets, discharge summaries, physician orders, faxes). The document may be scanned, skewed, handwritten or multi-page.

Rules:
- Extract ONLY what is written in the document. Never guess, infer or invent values. If a field is absent or illegible, return null (or an empty array) for it.
- Dates must be YYYY-MM-DD. If a date is ambiguous or partial, return null and add a warning.
- Names: split into firstName and lastName exactly as written. Do not correct spelling.
- Diagnoses: copy ICD-10-CM codes exactly as written; do not look up or assign codes that are not in the document. The primary diagnosis is the terminal/hospice-qualifying diagnosis if the document identifies one.
- codeStatus: use one of the allowed values only when the document states it; otherwise "Unknown".
- sex: "unknown" unless stated.
- Medications: one entry per medication with dose, route and frequency when written.
- fieldConfidence: for every field you filled in (and any you left null because it was unreadable), give a confidence between 0 and 1 using dotted paths such as "patient.lastName", "patient.dob", "patient.primaryDiagnosis", "patient.medications", "referralDate". Use low confidence (< 0.7) for handwriting, poor scan quality, or values you had to read across conflicting sections.
- warnings: short notes for the human reviewer about illegible sections, conflicting values (e.g. two different dates of birth), missing pages, or anything that needs verification. Do not include patient identifiers in warnings beyond the field name.
- Return JSON only, matching the response schema.`;

export class VertexGeminiExtractor implements Extractor {
  private client: GoogleGenAI | null = null;

  constructor(
    private readonly opts: { project?: string; location?: string; model?: string } = {},
  ) {}

  private getClient(): GoogleGenAI {
    if (!this.client) {
      const project = this.opts.project ?? process.env.GCLOUD_PROJECT ?? process.env.GOOGLE_CLOUD_PROJECT;
      if (!project) throw new Error('No Google Cloud project configured for Vertex AI');
      this.client = new GoogleGenAI({ vertexai: true, project, location: this.opts.location ?? VERTEX_LOCATION.value() });
    }
    return this.client;
  }

  async extract(input: ExtractorInput): Promise<ExtractorOutput> {
    const model = this.opts.model ?? GEMINI_MODEL.value();
    const response = await this.getClient().models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: input.mimeType, data: input.data.toString('base64') } },
            { text: 'Extract the hospice referral data from this document.' },
          ],
        },
      ],
      config: {
        systemInstruction: REFERRAL_SYSTEM_PROMPT,
        responseMimeType: 'application/json',
        responseSchema: REFERRAL_RESPONSE_SCHEMA,
        temperature: 0,
      },
    });
    const text = response.text;
    if (!text) throw new ExtractionError('model_empty', 'The model returned no output.');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new ExtractionError('model_invalid_json', 'The model returned invalid output.');
    }
    return { raw, model };
  }
}

/** Error with a PHI-free, user-facing message safe to store in `referral.error`. */
export class ExtractionError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = 'ExtractionError';
  }
}

let defaultExtractor: Extractor | null = null;
export function getDefaultExtractor(): Extractor {
  defaultExtractor ??= new VertexGeminiExtractor();
  return defaultExtractor;
}
