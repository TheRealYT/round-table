import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type Frame, type Transport } from '@round-table/protocol';

/**
 * The contract every Transport must pass (spec M0: "a second fake transport passes the same
 * tests"). Call it from a test file with a factory that returns two connected ends.
 */
export function describeTransportContract(
  name: string,
  connect: () => Promise<{ client: Transport; server: Transport; dispose(): Promise<void> }>,
): void {
  const next = (t: Transport) => new Promise<Frame>((resolve) => { const off = t.onFrame((f) => { off(); resolve(f); }); });

  describe(`Transport contract: ${name}`, () => {
    it('round-trips a request and its response', async () => {
      const { client, server, dispose } = await connect();
      const received = next(server);
      client.send({ v: PROTOCOL_VERSION, id: 'r1', type: 'req', payload: { proc: 'wait', input: { ack: [] } } });
      const req = await received;
      expect(req).toEqual({ v: PROTOCOL_VERSION, id: 'r1', type: 'req', payload: { proc: 'wait', input: { ack: [] } } });

      const reply = next(client);
      server.send({ v: PROTOCOL_VERSION, id: 'r1', type: 'res', payload: { output: { items: [] } } });
      expect(await reply).toMatchObject({ type: 'res', id: 'r1', payload: { output: { items: [] } } });
      await dispose();
    });

    it('keeps frame order', async () => {
      const { client, server, dispose } = await connect();
      const seen: string[] = [];
      const done = new Promise<void>((resolve) => server.onFrame((f) => { seen.push(f.id); if (seen.length === 50) resolve(); }));
      for (let i = 0; i < 50; i++) {
        client.send({ v: PROTOCOL_VERSION, id: `e${i}`, type: 'evt', payload: { topic: 'inbox', data: i } });
      }
      await done;
      expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => `e${i}`));
      await dispose();
    });

    it('tells both sides when one closes', async () => {
      const { client, server, dispose } = await connect();
      const serverClosed = new Promise<string>((resolve) => server.onClose(resolve));
      const clientClosed = new Promise<string>((resolve) => client.onClose(resolve));
      client.close('bye');
      await Promise.all([serverClosed, clientClosed]);
      expect(client.state).toBe('closed');
      expect(server.state).toBe('closed');
      expect(() => client.send({ v: PROTOCOL_VERSION, id: 'x', type: 'evt', payload: { topic: 't', data: null } })).toThrow();
      await dispose();
    });
  });
}
