import { useCallback, useEffect, useId, useState } from 'react';
import { HubError } from '@round-table/protocol';
import { useCommand, useHub, useQuery } from '../hub.tsx';
import { duration, usd } from '../format.ts';
import type { ReactNode } from 'react';
import type { LiveState, ProjectSummary, ProviderKindDef, ProviderList, ProviderRecord, ProviderSettings, RosterRecord } from '../types.ts';

/**
 * Agents (ADR-0018): set up each coding CLI once (a provider), then start as many agents from it
 * as a project needs. The hub runs them in their own worktrees and wakes them when there is work.
 */
export function AgentsView({ onOpenProject }: { onOpenProject: (projectId: string) => void }) {
  const { data, error } = useQuery<ProviderList>('provider.list', {}, { pollMs: 3_000 });
  const { data: projects } = useQuery<ProjectSummary[]>('project.list', {});
  const [adding, setAdding] = useState(false);
  if (!data) return <div className="view"><p className="muted">{error ?? 'Loading providers…'}</p></div>;
  const none = data.providers.length === 0;

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <h1>Agents</h1>
          <p className="lede">Set up each coding CLI once, then start as many agents from it as a project needs. The hub runs every agent in its own git worktree and wakes it when there is work. No chat window needed.</p>
        </div>
      </header>
      {!data.canRun && (
        <p className="nudge urgent" role="alert">This hub was started without an agent host, so it can’t run agents. Start it with <code>rt hub start</code>.</p>
      )}

      <section aria-labelledby="providers-h">
        <div className="section-head">
          <h2 id="providers-h">Providers</h2>
          <span className="muted small">A provider is one CLI tool with its sign-in, model and a limit on how many agents run at once.</span>
          {!adding && !none && <div className="actions"><button onClick={() => setAdding(true)}>Add a provider</button></div>}
        </div>
        {(adding || none) && <AddProvider kinds={data.kinds} onDone={() => setAdding(false)} canCancel={!none} />}
        <div className="providers">
          {data.providers.map((p) => (
            <ProviderCard key={p.providerId} provider={p} kind={data.kinds.find((k) => k.kind === p.settings.kind)} projects={projects ?? []} canRun={data.canRun} onOpenProject={onOpenProject} />
          ))}
        </div>
      </section>
    </div>
  );
}

// ── adding and editing ─────────────────────────────────────────────────────────────────

function AddProvider({ kinds, onDone, canCancel }: { kinds: ProviderKindDef[]; onDone: () => void; canCancel: boolean }) {
  const [kind, setKind] = useState<ProviderKindDef>();
  return (
    <div className="card stack" style={{ marginBottom: 'var(--space-5)' }}>
      <div className="row">
        <h3>{kind ? `Add ${kind.label}` : 'Which CLI should the agents run on?'}</h3>
        {canCancel && <button className="ghost small" style={{ marginLeft: 'auto' }} onClick={onDone}>Cancel</button>}
      </div>
      {!kind ? (
        <div className="kinds" role="group" aria-label="CLI tools">
          {kinds.map((k) => (
            <button key={k.kind} className="kind" aria-pressed={false} onClick={() => setKind(k)}>
              <strong>{k.label}</strong>
              <span className="mono small muted">{k.binary}</span>
              {k.driverVerified ? <span className="chip ok">Ready to run agents</span> : <span className="chip" title="Round Table hasn’t verified how to drive this CLI yet. You can set it up now; starting agents unlocks once its check passes.">Setup only for now</span>}
            </button>
          ))}
        </div>
      ) : (
        <ProviderForm kind={kind} onSaved={onDone} onCancel={() => setKind(undefined)} />
      )}
    </div>
  );
}

function ProviderForm({ kind, provider, onSaved, onCancel }: { kind: ProviderKindDef; provider?: ProviderRecord; onSaved: () => void; onCancel: () => void }) {
  const id = useId();
  const initial: ProviderSettings = { kind: kind.kind, label: kind.label, command: '', auth: 'cli-login', model: '', extraArgs: [], maxInstances: 3, env: [], secretEnv: [], ...provider?.settings };
  const [s, setS] = useState(initial);
  const [args, setArgs] = useState(initial.extraArgs.join(' '));
  const [key, setKey] = useState('');
  const [vars, setVars] = useState<EnvRow[]>(() => [
    ...(initial.env ?? []).map((e) => ({ name: e.name, value: e.value, secret: false, stored: false })),
    ...(initial.secretEnv ?? []).map((name) => ({ name, value: '', secret: true, stored: provider?.secretsSet.includes(name) ?? false })),
  ]);
  const varError = envError(vars);
  const [save, saving, saveError] = useCommand<{ providerId: string }>('provider.save');
  const [setSecret, settingSecret, secretError] = useCommand('provider.secret');
  const needsKey = s.auth === 'api-key' && !provider?.hasSecret && key.trim() === '';

  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (varError) return;
        const rows = vars.filter((v) => v.name.trim());
        const env = rows.filter((v) => !v.secret).map((v) => ({ name: v.name.trim(), value: v.value }));
        const secretEnv = rows.filter((v) => v.secret).map((v) => v.name.trim());
        const out = await save({ ...(provider && { providerId: provider.providerId }), settings: { ...s, label: s.label.trim() || kind.label, extraArgs: args.split(/\s+/).filter(Boolean), env, secretEnv } });
        if (!out) return;
        for (const v of rows.filter((r) => r.secret && r.value.trim())) {
          if (!(await setSecret({ providerId: out.providerId, name: v.name.trim(), value: v.value.trim() }))) return;
        }
        if (s.auth === 'api-key' && key.trim()) {
          const ok = await setSecret({ providerId: out.providerId, value: key.trim() });
          if (!ok) return;
        }
        onSaved();
      }}
    >
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${id}-label`}>Name</label>
          <input id={`${id}-label`} value={s.label} onChange={(e) => setS({ ...s, label: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-cmd`}>Binary</label>
          <input id={`${id}-cmd`} className="mono" value={s.command} placeholder={kind.binary} onChange={(e) => setS({ ...s, command: e.target.value })} />
          <span className="hint">Leave empty to use <code>{kind.binary}</code> from the hub’s PATH.</span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-model`}>Model</label>
          <input id={`${id}-model`} list={`${id}-models`} value={s.model} placeholder="CLI default" onChange={(e) => setS({ ...s, model: e.target.value })} />
          <datalist id={`${id}-models`}>{kind.models.map((m) => <option key={m} value={m} />)}</datalist>
        </div>
        <div className="field">
          <label htmlFor={`${id}-max`}>Agents at once</label>
          <input id={`${id}-max`} type="number" min={1} max={20} value={s.maxInstances} onChange={(e) => setS({ ...s, maxInstances: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} />
        </div>
      </div>
      <fieldset className="field" style={{ border: 'none', padding: 0, margin: 0 }}>
        <legend className="label">Sign-in</legend>
        <div className="segmented">
          <label><input type="radio" name={`${id}-auth`} checked={s.auth === 'cli-login'} onChange={() => setS({ ...s, auth: 'cli-login' })} /> The CLI’s own login</label>
          <label><input type="radio" name={`${id}-auth`} checked={s.auth === 'api-key'} onChange={() => setS({ ...s, auth: 'api-key' })} /> API key</label>
        </div>
        <span className="hint">{s.auth === 'cli-login' ? rich(kind.login) : `Passed to each agent as ${kind.apiKeyEnv}. The hub keeps it in a private file, never in its log, and nothing can read it back.`}</span>
      </fieldset>
      {s.auth === 'api-key' && (
        <div className="field" style={{ maxWidth: 460 }}>
          <label htmlFor={`${id}-key`}>{kind.apiKeyEnv}{provider?.hasSecret && <span className="faint"> · a key is set; enter a new one to replace it</span>}</label>
          <input id={`${id}-key`} type="password" autoComplete="off" spellCheck={false} className="mono" value={key} onChange={(e) => setKey(e.target.value)} placeholder={provider?.hasSecret ? '••••••••••••' : 'Paste the key'} />
        </div>
      )}
      <EnvEditor kind={kind} rows={vars} onChange={setVars} error={varError} />
      <details>
        <summary className="muted small">Advanced</summary>
        <div className="field" style={{ marginTop: 'var(--space-3)' }}>
          <label htmlFor={`${id}-args`}>Extra arguments</label>
          <input id={`${id}-args`} className="mono" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="--max-turns 40" />
          <span className="hint">Added to every agent’s command line, separated by spaces.</span>
        </div>
      </details>
      {(saveError || secretError) && <p className="error">{saveError ?? secretError}</p>}
      {needsKey && <p className="hint">Add the key now, or later from the provider card; agents can’t start without it.</p>}
      <div className="form-actions">
        <button className="primary" type="submit" disabled={saving || settingSecret || Boolean(varError)}>{provider ? 'Save changes' : `Add ${kind.label}`}</button>
        <button type="button" className="ghost" onClick={onCancel}>{provider ? 'Cancel' : 'Back'}</button>
      </div>
    </form>
  );
}

interface EnvRow { name: string; value: string; secret: boolean; stored: boolean }

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

function envError(rows: EnvRow[]): string | undefined {
  const named = rows.filter((r) => r.name.trim());
  const bad = named.find((r) => !ENV_NAME.test(r.name.trim()));
  if (bad) return `${bad.name.trim()} isn’t a valid variable name: use letters, digits and _, not starting with a digit.`;
  const names = named.map((r) => r.name.trim());
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) return `${dup} is set twice.`;
  const empty = named.find((r) => r.secret && !r.stored && !r.value.trim());
  if (empty) return `Enter a value for ${empty.name.trim()}.`;
  return undefined;
}

/** Custom environment for every agent from this provider: API endpoints, proxies, CLI switches. */
function EnvEditor({ kind, rows, onChange, error }: { kind: ProviderKindDef; rows: EnvRow[]; onChange: (rows: EnvRow[]) => void; error: string | undefined }) {
  const id = useId();
  const set = (i: number, patch: Partial<EnvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="field env" style={{ border: 'none', padding: 0, margin: 0 }}>
      <legend className="label">Environment variables</legend>
      <span className="hint">Passed to every agent from this provider, e.g. an API endpoint or a proxy. Mark tokens as secret: their values are kept like the API key, never in the log.</span>
      {rows.length > 0 && (
        <div className="env-rows">
          {rows.map((r, i) => (
            <div className="env-row" key={i}>
              <label className="sr-only" htmlFor={`${id}-n${i}`}>Variable name</label>
              <input id={`${id}-n${i}`} className="mono" list={`${id}-hints`} value={r.name} placeholder="NAME" spellCheck={false} onChange={(e) => set(i, { name: e.target.value })} />
              <label className="sr-only" htmlFor={`${id}-v${i}`}>Value of {r.name || 'the variable'}</label>
              <input
                id={`${id}-v${i}`}
                className="mono"
                type={r.secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                value={r.value}
                placeholder={r.secret ? (r.stored ? '•••••• set; type to replace' : 'secret value') : 'value'}
                onChange={(e) => set(i, { value: e.target.value })}
              />
              <label className="env-secret"><input type="checkbox" checked={r.secret} onChange={(e) => set(i, { secret: e.target.checked, value: e.target.checked ? r.value : r.stored ? '' : r.value, stored: e.target.checked && r.stored })} /> secret</label>
              <button type="button" className="ghost small" aria-label={`Remove ${r.name || 'variable'}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <datalist id={`${id}-hints`}>{kind.envHints.map((h) => <option key={h} value={h} />)}</datalist>
      {error && <p className="error">{error}</p>}
      <div><button type="button" className="small" onClick={() => onChange([...rows, { name: '', value: '', secret: false, stored: false }])}>Add variable</button></div>
    </fieldset>
  );
}

// ── a provider ─────────────────────────────────────────────────────────────────────────

interface Detection { found: boolean; version: string | null; path: string | null; error: string | null }

/** Runs a query once per input (and on demand), not on every hub change: detection starts a process. */
function useOnce<T>(proc: string, input: Record<string, unknown>) {
  const client = useHub();
  const [data, setData] = useState<T>();
  const [busy, setBusy] = useState(false);
  const key = JSON.stringify(input);
  const run = useCallback(async () => {
    if (!client) return;
    setBusy(true);
    try {
      setData(await client.call<T>(proc, input));
    } finally {
      setBusy(false);
    }
  }, [client, proc, key]);
  useEffect(() => void run(), [run]);
  return { data, busy, run };
}

function ProviderCard({ provider, kind, projects, canRun, onOpenProject }: { provider: ProviderRecord; kind: ProviderKindDef | undefined; projects: ProjectSummary[]; canRun: boolean; onOpenProject: (id: string) => void }) {
  const s = provider.settings;
  const client = useHub();
  const [editing, setEditing] = useState(false);
  const detect = useOnce<Detection>('provider.detect', { kind: s.kind, command: s.command });
  const [test, setTest] = useState<{ ok: boolean; message: string; ms: number; costUsd: number | null } | 'running'>();
  const [remove, removing, removeError] = useCommand('provider.remove');
  const [secret, , secretError] = useCommand('provider.secret');
  if (!kind) return null;
  const unsetVars = (s.secretEnv ?? []).filter((n) => !provider.secretsSet.includes(n));
  const needsKey = (s.auth === 'api-key' && !provider.hasSecret) || unsetVars.length > 0;
  const ready = kind.driverVerified && canRun && !needsKey && detect.data?.found !== false;

  const runTest = async () => {
    if (!client) return;
    setTest('running');
    try {
      setTest(await client.call('provider.test', { providerId: provider.providerId }));
    } catch (e) {
      setTest({ ok: false, message: e instanceof HubError ? e.message : String(e), ms: 0, costUsd: null });
    }
  };

  return (
    <article className="card provider" aria-label={s.label}>
      <div className="provider-head">
        <h3>{s.label}</h3>
        {s.label !== kind.label && <span className="chip">{kind.label}</span>}
        {kind.driverVerified ? <span className="chip ok">Can run agents</span> : <span className="chip">Setup only: driver not verified yet</span>}
        <span className="spacer" />
        <button className="small" onClick={runTest} disabled={test === 'running' || !kind.driverVerified}>{test === 'running' ? 'Testing…' : 'Test sign-in'}</button>
        <button className="small" onClick={() => setEditing(!editing)} aria-expanded={editing}>{editing ? 'Close' : 'Edit'}</button>
        <button className="small danger" disabled={removing || provider.running > 0} title={provider.running > 0 ? 'Stop its agents first' : undefined} onClick={() => remove({ providerId: provider.providerId })}>Remove</button>
      </div>
      {(removeError || secretError) && <p className="error" style={{ padding: '0 var(--space-5) var(--space-3)' }}>{removeError ?? secretError}</p>}
      {test && test !== 'running' && (
        <p className={`result ${test.ok ? 'ok' : 'bad'}`} style={{ margin: '0 var(--space-5) var(--space-4)' }} role="status">
          {test.ok ? '✓ ' : '✗ '}{test.message}{test.ms > 0 && ` · ${duration(test.ms)}`}{test.costUsd !== null && ` · ${usd(test.costUsd)}`}
        </p>
      )}
      {editing ? (
        <div className="provider-body" style={{ display: 'block' }}>
          <ProviderForm kind={kind} provider={provider} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
        </div>
      ) : (
        <div className="provider-body">
          <dl className="kv">
            <dt>Installed</dt>
            <dd>
              {detect.busy && !detect.data ? <span className="muted">Checking…</span>
                : detect.data?.found ? <><span className="state ok"><span className="dot" aria-hidden />{detect.data.version}</span> <span className="faint mono small">{detect.data.path}</span></>
                : <><span className="state bad"><span className="dot" aria-hidden />Not found</span> <span className="small muted">{detect.data?.error}</span><div className="small">Install on the hub machine: <code>{kind.install}</code></div></>}
              {' '}<button className="link small" onClick={() => void detect.run()}>Recheck</button>
            </dd>
            <dt>Binary</dt>
            <dd className="mono">{s.command || kind.binary}</dd>
            <dt>Model</dt>
            <dd>{s.model || <span className="muted">CLI default</span>}</dd>
            {s.extraArgs.length > 0 && (<><dt>Arguments</dt><dd className="mono small">{s.extraArgs.join(' ')}</dd></>)}
            {((s.env ?? []).length > 0 || (s.secretEnv ?? []).length > 0) && (
              <>
                <dt>Environment</dt>
                <dd className="env-list">
                  {(s.env ?? []).map((e) => <div key={e.name} className="mono small"><span>{e.name}</span>=<span className="muted">{e.value}</span></div>)}
                  {(s.secretEnv ?? []).map((n) => (
                    <div key={n} className="mono small">
                      <span>{n}</span>={provider.secretsSet.includes(n) ? <span className="muted">•••••• (secret)</span> : <span className="verdict bad">not set</span>}
                    </div>
                  ))}
                </dd>
              </>
            )}
          </dl>
          <dl className="kv">
            <dt>Sign-in</dt>
            <dd>{s.auth === 'cli-login' ? <>The CLI’s own login <div className="hint">{rich(kind.login)}</div></> : <>API key <span className="mono small faint">{kind.apiKeyEnv}</span></>}</dd>
            {s.auth === 'api-key' && (
              <>
                <dt>Key</dt>
                <dd>
                  {provider.hasSecret
                    ? <><span className="state ok"><span className="dot" aria-hidden />Set</span> <button className="link small" onClick={() => setEditing(true)}>Replace</button> · <button className="link small" onClick={() => secret({ providerId: provider.providerId, value: null })}>Remove</button></>
                    : <><span className="state bad"><span className="dot" aria-hidden />Not set</span> <button className="link small" onClick={() => setEditing(true)}>Add key</button></>}
                </dd>
              </>
            )}
            <dt>Running</dt>
            <dd className="num">{provider.running} of {s.maxInstances}</dd>
          </dl>
        </div>
      )}
      <div className="provider-foot">
        {!kind.driverVerified ? (
          <p className="small muted">Round Table doesn’t drive {kind.label} yet. To check it, run <code>node spikes/s8-drivers/check.mjs {kind.kind}</code> on the hub machine (where {kind.binary} is installed and logged in) and send back the report it makes. Your settings here are kept; starting agents unlocks once its driver is built.</p>
        ) : <SpawnForm provider={provider} projects={projects} ready={ready} reason={!kind.driverVerified ? `Round Table can’t run ${kind.label} yet: its driver hasn’t passed the check.` : !canRun ? 'This hub can’t run agents.' : needsKey ? (unsetVars.length > 0 ? `Set a value for ${unsetVars.join(', ')} first (Edit).` : 'Add the API key first.') : detect.data?.found === false ? `${kind.binary} isn’t installed on the hub machine.` : undefined} />}
        {provider.agents.length > 0 && <ProviderAgents provider={provider} projects={projects} onOpenProject={onOpenProject} />}
      </div>
    </article>
  );
}

/** `code` spans in registry text. */
function rich(text: string): ReactNode {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

const NAMES = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kit', 'Lu', 'Max', 'Nia', 'Oz', 'Pia', 'Quin', 'Rae', 'Sol', 'Tam'];

function SpawnForm({ provider, projects, ready, reason }: { provider: ProviderRecord; projects: ProjectSummary[]; ready: boolean; reason: string | undefined }) {
  const id = useId();
  const [projectId, setProjectId] = useState(projects[0]?.projectId ?? '');
  useEffect(() => {
    if (!projectId && projects[0]) setProjectId(projects[0].projectId);
  }, [projects, projectId]);
  const { data: roster } = useQuery<{ records: RosterRecord[] }>('board_read', projectId ? { section: 'roster', projectId } : undefined);
  const taken = new Set((roster?.records ?? []).filter((r) => r.state !== 'removed' && r.state !== 'left').map((r) => r.name.toLowerCase()));
  const free = Math.max(0, provider.settings.maxInstances - provider.running);
  const suggestion = NAMES.filter((n) => !taken.has(n.toLowerCase())).slice(0, Math.min(2, Math.max(1, free))).join(', ');
  const [names, setNames] = useState('');
  const [spawn, spawning, error] = useCommand<{ started: Array<{ name: string }>; failed: Array<{ name: string; error: string }> }>('agent.spawn');
  const [outcome, setOutcome] = useState<{ started: Array<{ name: string }>; failed: Array<{ name: string; error: string }> }>();
  const list = (names.trim() || suggestion).split(/[,\n]/).map((n) => n.trim()).filter(Boolean);

  if (projects.length === 0) return <p className="muted small">Create a project in the sidebar, then start agents into it.</p>;
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const out = await spawn({ projectId, providerId: provider.providerId, names: list, tags: [] });
        if (out) {
          setOutcome(out);
          if (out.failed.length === 0) setNames('');
        }
      }}
    >
      <div className="spawn">
        <div className="field">
          <label htmlFor={`${id}-project`}>Start agents in</label>
          <select id={`${id}-project`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-names`}>Names, one agent each</label>
          <input id={`${id}-names`} value={names} onChange={(e) => setNames(e.target.value)} placeholder={suggestion || 'Ada, Bo'} />
        </div>
        <button className="primary" type="submit" disabled={!ready || spawning || list.length === 0} title={reason}>
          {spawning ? 'Starting…' : `Start ${list.length} agent${list.length === 1 ? '' : 's'}`}
        </button>
      </div>
      {!ready && reason && <p className="hint">{reason}</p>}
      {error && <p className="error">{error}</p>}
      {outcome && (
        <p className="small" role="status">
          {outcome.started.length > 0 && <span className="verdict ok">Started {outcome.started.map((s) => s.name).join(', ')}. </span>}
          {outcome.failed.map((f) => <span key={f.name} className="verdict bad">{f.name}: {f.error}. </span>)}
        </p>
      )}
    </form>
  );
}

function ProviderAgents({ provider, projects, onOpenProject }: { provider: ProviderRecord; projects: ProjectSummary[]; onOpenProject: (id: string) => void }) {
  const [setRun, busy] = useCommand('agent.run');
  const projectName = (id: string) => projects.find((p) => p.projectId === id)?.name ?? id;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Agent</th><th>Project</th><th>Status</th><th className="num">Cost</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {provider.agents.map((a) => (
            <tr key={a.agentId}>
              <td><strong>{a.name}</strong></td>
              <td><button className="link" onClick={() => onOpenProject(a.projectId)}>{projectName(a.projectId)}</button></td>
              <td><RunState live={a.live} />{a.live?.status === 'crashed' && a.live.lastError && <div className="small faint">{a.live.lastError}</div>}</td>
              <td className="num">{usd(a.costUsd)}</td>
              <td style={{ textAlign: 'right' }}>
                {a.run && a.live?.status === 'crashed' && <button className="small primary" disabled={busy} onClick={() => setRun({ projectId: a.projectId, agentId: a.agentId, run: true })} style={{ marginRight: 'var(--space-2)' }}>Restart</button>}
                {a.run
                  ? <button className="small" disabled={busy} onClick={() => setRun({ projectId: a.projectId, agentId: a.agentId, run: false })}>Stop</button>
                  : <button className="small" disabled={busy} onClick={() => setRun({ projectId: a.projectId, agentId: a.agentId, run: true })}>Start</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = { working: 'working', idle: 'idle', starting: 'starting', stopped: 'stopped', crashed: 'crashed' };

export function RunState({ live }: { live: LiveState | null | undefined }) {
  const status = live?.status ?? 'stopped';
  return (
    <span className={`state ${status}`} title={live?.lastError ?? undefined}>
      <span className="dot" aria-hidden />{STATUS_LABEL[status]}{status === 'working' && live?.tool ? <span className="faint mono">&nbsp;· {live.tool.replace(/^mcp__[^_]+__/, '')}</span> : null}
    </span>
  );
}
