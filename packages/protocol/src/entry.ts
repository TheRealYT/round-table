import { z } from 'zod';
import { Refs, Via } from './event.ts';

export const Criticality = z.enum(['normal', 'critical']);
export type Criticality = z.infer<typeof Criticality>;

/**
 * Envelope shared by every document-section entry (spec: Shared board → Sections).
 * Entries are never edited in place: a change is a new version that supersedes the old one.
 * `data` is validated by the section's own schema.
 */
export const EntryEnvelope = z.object({
  id: z.string(),
  section: z.string(),
  version: z.number().int().positive(),
  author: z.string(),
  via: Via,
  createdAt: z.number().int(),
  supersedes: z.string().nullable(),
  refs: Refs,
  tags: z.array(z.string()),
  criticality: Criticality,
  reason: z.string().nullable(),
  data: z.unknown(),
});
export type EntryEnvelope = z.infer<typeof EntryEnvelope>;
