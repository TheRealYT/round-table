import { createMemoryPair, MemoryNetwork, type Transport } from '@round-table/protocol';
import { WsConnector, WsListener } from '@round-table/protocol/ws';
import { describeTransportContract } from '../src/index.ts';

describeTransportContract('memory pair', async () => {
  const [client, server] = createMemoryPair();
  return { client, server, dispose: async () => {} };
});

describeTransportContract('memory network', async () => {
  const network = new MemoryNetwork();
  const accepted = new Promise<Transport>((resolve) => network.onConnection((t) => resolve(t)));
  const client = await network.connect('agent');
  return { client, server: await accepted, dispose: () => network.close() };
});

describeTransportContract('local WebSocket', async () => {
  const listener = await WsListener.listen(0);
  const accepted = new Promise<Transport>((resolve) => listener.onConnection((t, info) => {
    if (info.endpoint === 'agent') resolve(t);
  }));
  const client = await new WsConnector(`ws://127.0.0.1:${listener.port}`).connect('agent');
  return { client, server: await accepted, dispose: () => listener.close() };
});
