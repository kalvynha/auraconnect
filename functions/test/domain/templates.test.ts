import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PLACEHOLDERS,
  DEFAULT_TEMPLATES,
  fillTemplate,
  stripTemplateMarker,
  TEMPLATE_FIELD_KEY_RE,
  TEMPLATE_ID_RE,
  templatePlaceholders,
  unknownPlaceholders,
} from '../../src/domain/templates';
import { DEFAULT_QUICK_REPLIES } from '../../src/shared/types';

const byTitle = (t: string) => DEFAULT_TEMPLATES.find((d) => d.template.title.startsWith(t))!;

describe('stripTemplateMarker', () => {
  it('strips a leading [[tpl:id]] marker and returns the id', () => {
    expect(stripTemplateMarker('[[tpl:default-sbar]]SBAR for Pat')).toEqual({ body: 'SBAR for Pat', templateId: 'default-sbar' });
    expect(stripTemplateMarker('  [[tpl:abc_1]] hello')).toEqual({ body: 'hello', templateId: 'abc_1' });
    expect(stripTemplateMarker('[[tpl:x]]\nline 2')).toEqual({ body: 'line 2', templateId: 'x' });
  });

  it('leaves bodies without a well-formed leading marker alone', () => {
    for (const body of ['hello', 'see [[tpl:x]] later', '[[tpl:]]x', '[[tpl:a/b]]x', '[[tpl:x]', '']) {
      expect(stripTemplateMarker(body)).toEqual({ body, templateId: null });
    }
  });

  it('only strips the first marker', () => {
    expect(stripTemplateMarker('[[tpl:a]][[tpl:b]]x')).toEqual({ body: '[[tpl:b]]x', templateId: 'a' });
  });
});

describe('placeholders', () => {
  it('lists distinct placeholders in order and fills known ones', () => {
    expect(templatePlaceholders('{{a}} {{ b }} {{a}} {{9x}}')).toEqual(['a', 'b']);
    expect(fillTemplate('Hi {{me}}, {{x}}', { me: 'RN Kim' })).toBe('Hi RN Kim, {{x}}');
  });

  it('reports placeholders that are neither built in nor fields', () => {
    expect(unknownPlaceholders({ body: '{{patient}} {{S}} {{oops}}', fields: [{ key: 'S', label: 'S', kind: 'text', required: true }] })).toEqual(['oops']);
  });
});

describe('DEFAULT_TEMPLATES', () => {
  it('has unique, valid ids and the spec’d set', () => {
    const ids = DEFAULT_TEMPLATES.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of ids) expect(i).toMatch(TEMPLATE_ID_RE);
    const titles = DEFAULT_TEMPLATES.map((d) => d.template.title);
    for (const t of ['SBAR', 'Fall report', 'Symptom crisis', 'Death notification', 'Visit update', 'Medication refill', 'Comfort kit', 'DME', 'Family update', 'Running late', 'Call me when free']) {
      expect(titles.some((x) => x.startsWith(t))).toBe(true);
    }
    const quick = DEFAULT_TEMPLATES.filter((d) => d.template.category === 'quick_reply').map((d) => d.template.body);
    expect(quick).toEqual([...DEFAULT_QUICK_REPLIES]);
  });

  it('SBAR is urgent with fields S, B, A, R used in the body', () => {
    const sbar = byTitle('SBAR').template;
    expect(sbar.defaultPriority).toBe('urgent');
    expect(sbar.category).toBe('escalation');
    expect(sbar.fields.map((f) => f.key)).toEqual(['S', 'B', 'A', 'R']);
    for (const k of ['S', 'B', 'A', 'R']) expect(sbar.body).toContain(`{{${k}}}`);
    expect(sbar.patientContext).toBe(true);
  });

  it('every template is well-formed: only known placeholders, used fields, valid keys, choice options', () => {
    for (const { id, template: t } of DEFAULT_TEMPLATES) {
      expect(unknownPlaceholders(t), id).toEqual([]);
      const used = templatePlaceholders(t.body);
      for (const f of t.fields) {
        expect(f.key, id).toMatch(TEMPLATE_FIELD_KEY_RE);
        expect(used, `${id}.${f.key} unused`).toContain(f.key);
        if (f.kind === 'choice') expect(f.options?.length, id).toBeGreaterThan(0);
        else expect(f.options, id).toBeUndefined();
      }
      expect(t.active).toBe(true);
      expect(t.body.length).toBeLessThanOrEqual(4000);
      expect(t.title.length).toBeLessThanOrEqual(100);
    }
  });

  it('is PHI-free: filling only the placeholders with blanks leaves no names, numbers or dates', () => {
    const blank = Object.fromEntries([...BUILTIN_PLACEHOLDERS, ...DEFAULT_TEMPLATES.flatMap((d) => d.template.fields.map((f) => f.key))].map((k) => [k, '']));
    for (const { id, template: t } of DEFAULT_TEMPLATES) {
      const filled = fillTemplate(t.body, blank);
      expect(filled, id).not.toMatch(/\d{3}/); // no phone numbers, MRNs, dates
      expect(filled, id).not.toMatch(/\{\{/);
    }
    // Patient-specific context only ever comes from placeholders.
    const sbar = byTitle('SBAR').template.body;
    expect(sbar).toContain('{{patient}}');
    expect(sbar).toContain('{{codeStatus}}');
  });

  it('patient-specific templates are marked patientContext; generic ones are not', () => {
    for (const { template: t } of DEFAULT_TEMPLATES) {
      if (t.body.includes('{{patient}}')) expect(t.patientContext).toBe(true);
    }
    expect(byTitle('Running late').template.patientContext).toBe(false);
    expect(byTitle('Call me').template.patientContext).toBe(false);
  });
});
