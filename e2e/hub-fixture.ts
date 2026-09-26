import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHttpServer, Hub } from '@round-table/hub';
import { WsConnector, WsListener } from '@round-table/protocol/ws';
import { generateIdentityKey } from '@round-table/protocol/crypto';
import { HubClient } from '@round-table/protocol';

/** A real hub on a real port serving the built app, as `rt hub start` runs it. */
export async function startHub() {
  const dir = mkdtempSync(join(tmpdir(), 'rt-e2e-'));
  const hub = new Hub({ storePath: join(dir, 'hub.db'), hubKey: generateIdentityKey() });
  const http = createHttpServer(hub, { appDir: resolve(import.meta.dirname, '../packages/app/dist') });
  hub.listen(WsListener.attach(http));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    hub,
    base,
    loginUrl: () => `${base}/login?t=${hub.createLoginToken()}`,
    agent: async () => new HubClient(await new WsConnector(`ws://127.0.0.1:${port}`).connect('agent')),
    /** The human's API outside the browser (same cookie the app gets from /login). */
    human: async () =>
      new HubClient(await new WsConnector(`ws://127.0.0.1:${port}`, { headers: { cookie: `rt_session=${hub.createHumanSession()}` } }).connect('app')),
    close: async () => {
      hub.close();
      await new Promise((r) => http.close(r));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
