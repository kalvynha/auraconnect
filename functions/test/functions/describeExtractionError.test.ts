import { describe, expect, it } from 'vitest';
import { describeExtractionError } from '../../src/referrals/runExtraction';

describe('describeExtractionError', () => {
  it('explains Vertex permission errors', () => {
    const r = describeExtractionError(Object.assign(new Error('Permission denied on aiplatform'), { status: 403 }));
    expect(r.publicMessage).toContain('roles/aiplatform.user');
    expect(r.logFields).toMatchObject({ status: 403 });
  });
  it('explains missing models', () => {
    expect(describeExtractionError(Object.assign(new Error('not found'), { status: 404 })).publicMessage).toContain('GEMINI_MODEL');
  });
  it('never logs messages of non-API errors', () => {
    const r = describeExtractionError(new Error('Patient John Doe DOB 1/1/1940'));
    expect(JSON.stringify(r.logFields)).not.toContain('John');
  });
});
