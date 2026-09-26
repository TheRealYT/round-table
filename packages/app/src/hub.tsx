import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { HubClient, HubError } from '@round-table/protocol';
import { BrowserWsTransport } from './transport.ts';

type Status = { kind: 'connecting' } | { kind: 'open'; client: HubClient } | { kind: 'closed'; reason: string };

const HubContext = createContext<Status>({ kind: 'connecting' });

/** One live connection to the hub for the whole app; reconnects with backoff. */
export function HubProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>({ kind: 'connecting' });
  useEffect(() => {
    let stopped = false;
    let delay = 500;
    let current: HubClient | undefined;
    const connect = async () => {
      try {
        const client = new HubClient(await BrowserWsTransport.connect());
        current = client;
        client.onClose((reason) => {
          if (stopped) return;
          setStatus({ kind: 'closed', reason });
          if (reason !== 'unauthenticated' && reason !== 'forbidden') setTimeout(connect, delay);
        });
        delay = 500;
        setStatus({ kind: 'open', client });
      } catch (error) {
        if (stopped) return;
        setStatus({ kind: 'closed', reason: error instanceof Error ? error.message : 'cannot reach the hub' });
        delay = Math.min(delay * 2, 10_000);
        setTimeout(connect, delay);
      }
    };
    void connect();
    return () => {
      stopped = true;
      current?.close();
    };
  }, []);
  return <HubContext.Provider value={status}>{children}</HubContext.Provider>;
}

export function useHubStatus(): Status {
  return useContext(HubContext);
}

export function useHub(): HubClient | undefined {
  const status = useContext(HubContext);
  return status.kind === 'open' ? status.client : undefined;
}

/**
 * Runs a query procedure and re-runs it whenever the hub reports a change (architecture §7:
 * the app refetches; it never replays events itself).
 */
export function useQuery<T>(proc: string, input: Record<string, unknown> | undefined, options: { pollMs?: number } = {}): { data: T | undefined; error: string | undefined } {
  const client = useHub();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const key = JSON.stringify(input ?? null);
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined);

  const run = useCallback(() => {
    if (!client || input === undefined) return;
    client.call<T>(proc, input).then(
      (value) => {
        setData(value);
        setError(undefined);
      },
      (e: unknown) => setError(e instanceof HubError ? e.message : String(e)),
    );
  }, [client, proc, key]);

  useEffect(() => {
    setData(undefined);
    run();
    if (!client) return;
    const off = client.on('changed', () => {
      clearTimeout(pending.current);
      pending.current = setTimeout(run, 80);
    });
    // Some state changes without events (e.g. whether an agent's model is still calling tools).
    const poll = options.pollMs ? setInterval(run, options.pollMs) : undefined;
    return () => {
      off();
      if (poll) clearInterval(poll);
    };
  }, [client, run, options.pollMs]);

  return { data, error };
}

/** Calls a command; returns [call, busy, error]. */
export function useCommand<T = unknown>(proc: string): [(input: Record<string, unknown>) => Promise<T | undefined>, boolean, string | undefined] {
  const client = useHub();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const call = useCallback(
    async (input: Record<string, unknown>) => {
      if (!client) return undefined;
      setBusy(true);
      setError(undefined);
      try {
        return await client.call<T>(proc, input);
      } catch (e) {
        setError(e instanceof HubError ? e.message : String(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [client, proc],
  );
  return [call, busy, error];
}
