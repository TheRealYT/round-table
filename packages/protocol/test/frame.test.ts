import { describe, expect, it } from 'vitest';
import { decodeFrame, encodeFrame, PROTOCOL_VERSION, ProtocolError, type Frame } from '../src/index.ts';

describe('frames', () => {
  it('round-trips every frame type', () => {
    const frames: Frame[] = [
      { v: PROTOCOL_VERSION, id: '1', type: 'req', payload: { proc: 'claim', input: { taskId: 'x' }, epoch: 3 } },
      { v: PROTOCOL_VERSION, id: '1', type: 'res', payload: { output: null } },
      { v: PROTOCOL_VERSION, id: '1', type: 'err', payload: { code: 'forbidden', message: 'leader only' } },
      { v: PROTOCOL_VERSION, id: '2', type: 'evt', payload: { topic: 'inbox', data: { human: 1 } } },
    ];
    for (const frame of frames) expect(decodeFrame(encodeFrame(frame))).toEqual(frame);
  });

  it('rejects other protocol versions with unsupported_version', () => {
    const error = catchError(() => decodeFrame(JSON.stringify({ v: 99, id: '1', type: 'res', payload: { output: 1 } })));
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe('unsupported_version');
  });

  it('rejects malformed frames with bad_frame', () => {
    for (const text of ['not json', '{"v":1,"id":"1","type":"nope","payload":{}}', '{"v":1,"type":"res","payload":{}}']) {
      expect((catchError(() => decodeFrame(text)) as ProtocolError).code).toBe('bad_frame');
    }
  });
});

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected an error');
}
