import { z } from 'zod';

/** Wire protocol version. Bump on any incompatible frame change. */
export const PROTOCOL_VERSION = 1;

/** Error codes every layer can return. Domain rejections use `rejected` with a domain code in `details`. */
export const ErrorCode = z.enum([
  'bad_frame',
  'unsupported_version',
  'unknown_procedure',
  'invalid_input',
  'forbidden',
  'unauthenticated',
  'fenced',
  'rate_limited',
  'rejected',
  'internal',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

const base = { v: z.literal(PROTOCOL_VERSION), id: z.string().min(1) };

/** A call to a procedure from the catalog. `epoch` is set once the session is authenticated. */
export const RequestFrame = z.object({
  ...base,
  type: z.literal('req'),
  payload: z.object({
    proc: z.string().min(1),
    input: z.unknown(),
    epoch: z.number().int().nonnegative().optional(),
  }),
});

/** Successful reply; `id` echoes the request id. */
export const ResponseFrame = z.object({
  ...base,
  type: z.literal('res'),
  payload: z.object({ output: z.unknown() }),
});

/** Failed reply; `id` echoes the request id (or is `-` for frames that could not be parsed). */
export const ErrorFrame = z.object({
  ...base,
  type: z.literal('err'),
  payload: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

/** Server push that is not a reply: inbox counts, control messages, app live-feed notices. */
export const EventFrame = z.object({
  ...base,
  type: z.literal('evt'),
  payload: z.object({ topic: z.string().min(1), data: z.unknown() }),
});

export const Frame = z.discriminatedUnion('type', [RequestFrame, ResponseFrame, ErrorFrame, EventFrame]);
export type Frame = z.infer<typeof Frame>;
export type RequestFrame = z.infer<typeof RequestFrame>;
export type ResponseFrame = z.infer<typeof ResponseFrame>;
export type ErrorFrame = z.infer<typeof ErrorFrame>;
export type EventFrame = z.infer<typeof EventFrame>;

export class ProtocolError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

/** Parses and validates one frame. Throws `ProtocolError` with `unsupported_version` or `bad_frame`. */
export function decodeFrame(text: string): Frame {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ProtocolError('bad_frame', 'frame is not valid JSON');
  }
  if (typeof raw === 'object' && raw !== null && 'v' in raw && raw.v !== PROTOCOL_VERSION) {
    throw new ProtocolError('unsupported_version', `unsupported protocol version ${String(raw.v)}`);
  }
  const parsed = Frame.safeParse(raw);
  if (!parsed.success) throw new ProtocolError('bad_frame', parsed.error.message);
  return parsed.data;
}
