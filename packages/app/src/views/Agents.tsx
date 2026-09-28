import { useCallback, useEffect, useState, useId, type ReactNode } from 'react';
import { HubError } from '@round-table/protocol';
import { Bot, ChevronRight, CircleCheck, CircleX, Cpu, FolderGit2, KeyRound, List, Pencil, Plus, Rocket, Square, Play, RotateCcw, Terminal, Trash2, Variable, Zap } from 'lucide-react';
import { go } from '../App.tsx';
import { useCommand, useHub, useQuery } from '../hub.tsx';
import { duration, usd } from '../format.ts';
import type { ProjectSummary, ProviderKindDef, ProviderList, ProviderRecord, ProviderSettings } from '../types.ts';
import { Avatar, RunState, Sheet, useToast } from '../ui.tsx';
import { ProviderLogo, StartAgentsSheet } from './StartAgents.tsx';

/**
 * Agents (ADR-0018): set up each coding CLI once (a provider), then start as many agents from it
 * as a project needs. The hub runs them in their own worktrees and wakes them when there is work.
 */
export function AgentsView() {
  const { data, error } = useQuery<ProviderList>('provider.list', {}, { pollMs: 3_000 });
  const { data: projects } = useQuery<ProjectSummary[]>('project.list', {});
  const [adding, setAdding] = useState<ProviderKindDef | true | false>(false);
  const [starting, setStarting] = useState<string>();
  if (!data) return <div className="page"><p className="muted">{error ?? 'Loading providers…'}</p></div>;
  const agents = data.providers.flatMap((p) => p.agents);
  const running = agents.filter((a) => a.run).length;
  const spend = agents.reduce((n, a) => n + a.costUsd, 0);

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow"><Bot size={14} /> Agents</div>
          <h1>Providers and agents</h1>
          <p className="lede">Set up each coding CLI once, then start as many agents from it as a project needs. The hub runs every agent in its own git worktree and wakes it when there is work. No chat window needed.</p>
        </div>
        <div className="actions">
          <button onClick={() => setAdding(true)}><Plus /> Add a provider</button>
          <button className="primary" onClick={() => setStarting('')} disabled={data.providers.length === 0}><Rocket /> Start agents</button>
        </div>
      </header>
      {!data.canRun && <p className="nudge urgent" role="alert" style={{ marginBottom: 'var(--s-5)' }}>This hub was started without an agent host, so it can’t run agents. Start it with <code>rt hub start</code>.</p>}

      {data.providers.length > 0 && (
        <div className="statline">
          <div className="stat"><span className="v">{data.providers.length}</span><span className="k"><Cpu /> providers</span></div>
          <div className="stat"><span className="v">{running}<small>/{agents.length}</small></span><span className="k"><Bot /> agents running</span></div>
          <div className="stat"><span className="v">{agents.filter((a) => a.live?.status === 'working').length}</span><span className="k"><Zap /> working now</span></div>
          <div className="stat"><span className="v">{usd(spend)}</span><span className="k"><Terminal /> spent</span></div>
        </div>
      )}

      {data.providers.length === 0 ? (
        <section className="section">
          <div className="section-head"><h2>Pick the CLI your agents run on</h2></div>
          <KindPicker kinds={data.kinds} onPick={(k) => setAdding(k)} />
        </section>
      ) : (
        <div className="providers">
          {data.providers.map((p) => (
            <ProviderCard key={p.providerId} provider={p} kind={data.kinds.find((k) => k.kind === p.settings.kind)} projects={projects ?? []} canRun={data.canRun} onStart={() => setStarting(p.providerId)} />
          ))}
        </div>
      )}
      <AddProviderSheet open={adding !== false} initial={adding === true || adding === false ? undefined : adding} onClose={() => setAdding(false)} kinds={data.kinds} />
      <StartAgentsSheet open={starting !== undefined} onClose={() => setStarting(undefined)} {...(starting ? { providerId: starting } : {})} />
    </div>
  );
}

function KindPicker({ kinds, onPick, picked }: { kinds: ProviderKindDef[]; onPick: (k: ProviderKindDef) => void; picked?: string }) {
  return (
    <div className="kinds" role="group" aria-label="CLI tools">
      {kinds.map((k) => (
        <button key={k.kind} className="kind" aria-pressed={picked === k.kind} onClick={() => onPick(k)}>
          <ProviderLogo kind={k.kind} />
          <strong>{k.label}</strong>
          <span className="mono xs faint">{k.binary}</span>
          {k.driverVerified ? <span className="badge good"><CircleCheck /> Ready to run agents</span> : <span className="badge" title="Round Table hasn’t verified how to drive this CLI yet. You can set it up now; starting agents unlocks once its check passes.">Setup only for now</span>}
        </button>
      ))}
    </div>
  );
}

function AddProviderSheet({ open, onClose, kinds, initial }: { open: boolean; onClose: () => void; kinds: ProviderKindDef[]; initial?: ProviderKindDef }) {
  const [kind, setKind] = useState<ProviderKindDef | undefined>(initial);
  const toast = useToast();
  useEffect(() => {
    if (open) setKind(initial);
  }, [open, initial]);
  return (
    <Sheet open={open} onClose={onClose} title={kind ? `Add ${kind.label}` : 'Add a provider'}>
      {!kind ? <KindPicker kinds={kinds} onPick={setKind} /> : (
        <ProviderForm kind={kind} onSaved={() => { toast(`${kind.label} added`); onClose(); }} onCancel={() => setKind(undefined)} />
      )}
    </Sheet>
  );
}

function ProviderForm({ kind, provider, onSaved, onCancel }: { kind: ProviderKindDef; provider?: ProviderRecord; onSaved: () => void; onCancel: () => void }) {
  const id = useId();
  const initial: ProviderSettings = { kind: kind.kind, label: kind.label, command: '', auth: 'cli-login', model: '', effort: '', extraArgs: [], maxInstances: 3, env: [], secretEnv: [], ...provider?.settings };
  const [listed, setListed] = useState<string[]>([]);
  const [listing, setListing] = useState<string | null>(null);
  const client = useHub();
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
          <input id={`${id}-cmd`} className="mono-input" value={s.command} placeholder={kind.binary} onChange={(e) => setS({ ...s, command: e.target.value })} />
          <span className="hint">Leave empty to use <code>{kind.binary}</code> from the hub’s PATH.</span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-model`}>Model</label>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input id={`${id}-model`} className="mono-input" list={`${id}-models`} value={s.model} placeholder="CLI default" onChange={(e) => setS({ ...s, model: e.target.value })} />
            {kind.listModels && provider && (
              <button
                type="button"
                className="sm"
                title={`Ask ${kind.binary} which models it offers`}
                onClick={async () => {
                  setListing('Asking…');
                  try {
                    if (!client) throw new Error('not connected to the hub');
                    const out = await client.call<{ models: string[]; error: string | null }>('provider.models', { providerId: provider.providerId });
                    setListed(out.models);
                    setListing(out.models.length ? `${out.models.length} models from ${kind.binary}` : out.error ?? 'none listed');
                  } catch (error) {
                    setListing(error instanceof Error ? error.message : String(error));
                  }
                }}
              >
                <List /> List
              </button>
            )}
          </div>
          <datalist id={`${id}-models`}>{[...new Set([...listed, ...kind.models])].map((m) => <option key={m} value={m} />)}</datalist>
          <span className="hint">{listing ?? (kind.models.length ? `e.g. ${kind.models.join(', ')}` : 'Any name the CLI accepts.')}</span>
        </div>
        {kind.efforts.length > 0 && (
          <div className="field">
            <label htmlFor={`${id}-effort`}>Effort</label>
            <select id={`${id}-effort`} value={s.effort} onChange={(e) => setS({ ...s, effort: e.target.value })}>
              <option value="">CLI default</option>
              {kind.efforts.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            <span className="hint">How hard the model thinks. Lower is faster and cheaper; each agent or role can change it.</span>
          </div>
        )}
        <div className="field">
          <label htmlFor={`${id}-max`}>Agents at once</label>
          <input id={`${id}-max`} type="number" min={1} max={20} value={s.maxInstances} onChange={(e) => setS({ ...s, maxInstances: Math.max(1, Math.min(20, Number(e.target.value) || 1)) })} />
        </div>
      </div>
      <fieldset className="field" >
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
          <input id={`${id}-key`} type="password" autoComplete="off" spellCheck={false} className="mono-input" value={key} onChange={(e) => setKey(e.target.value)} placeholder={provider?.hasSecret ? '••••••••••••' : 'Paste the key'} />
        </div>
      )}
      <EnvEditor kind={kind} rows={vars} onChange={setVars} error={varError} />
      <details>
        <summary><ChevronRight /> Advanced</summary>
        <div className="field" style={{ marginTop: 'var(--s-3)' }}>
          <label htmlFor={`${id}-args`}>Extra arguments</label>
          <input id={`${id}-args`} className="mono-input" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="--max-turns 40" />
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
    <fieldset className="field env" >
      <legend className="label">Environment variables</legend>
      <span className="hint">Passed to every agent from this provider, e.g. an API endpoint or a proxy. Mark tokens as secret: their values are kept like the API key, never in the log.</span>
      {rows.length > 0 && (
        <div className="env-rows">
          {rows.map((r, i) => (
            <div className="env-row" key={i}>
              <label className="sr-only" htmlFor={`${id}-n${i}`}>Variable name</label>
              <input id={`${id}-n${i}`} className="mono-input" list={`${id}-hints`} value={r.name} placeholder="NAME" spellCheck={false} onChange={(e) => set(i, { name: e.target.value })} />
              <label className="sr-only" htmlFor={`${id}-v${i}`}>Value of {r.name || 'the variable'}</label>
              <input
                id={`${id}-v${i}`}
                className="mono-input"
                type={r.secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                value={r.value}
                placeholder={r.secret ? (r.stored ? '•••••• set; type to replace' : 'secret value') : 'value'}
                onChange={(e) => set(i, { value: e.target.value })}
              />
              <label className="env-secret"><input type="checkbox" checked={r.secret} onChange={(e) => set(i, { secret: e.target.checked, value: e.target.checked ? r.value : r.stored ? '' : r.value, stored: e.target.checked && r.stored })} /> secret</label>
              <button type="button" className="ghost sm" aria-label={`Remove ${r.name || 'variable'}`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <datalist id={`${id}-hints`}>{kind.envHints.map((h) => <option key={h} value={h} />)}</datalist>
      {error && <p className="error">{error}</p>}
      <div><button type="button" className="sm" onClick={() => onChange([...rows, { name: '', value: '', secret: false, stored: false }])}>Add variable</button></div>
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
  }, [client, proc, key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void run(), [run]);
  return { data, busy, run };
}

/** `code` spans in registry text. */
function rich(text: string): ReactNode {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}

function ProviderCard({ provider, kind, projects, canRun, onStart }: { provider: ProviderRecord; kind: ProviderKindDef | undefined; projects: ProjectSummary[]; canRun: boolean; onStart: () => void }) {
  const s = provider.settings;
  const client = useHub();
  const [editing, setEditing] = useState(false);
  const detect = useOnce<Detection>('provider.detect', { kind: s.kind, command: s.command });
  const [test, setTest] = useState<{ ok: boolean; message: string; ms: number; costUsd: number | null } | 'running'>();
  const [remove, removing, removeError] = useCommand('provider.remove');
  const [secret, , secretError] = useCommand('provider.secret');
  const toast = useToast();
  if (!kind) return null;
  const unsetVars = (s.secretEnv ?? []).filter((n) => !provider.secretsSet.includes(n));
  const needsKey = (s.auth === 'api-key' && !provider.hasSecret) || unsetVars.length > 0;
  const ready = kind.driverVerified && canRun && !needsKey && detect.data?.found !== false;
  const reason = !kind.driverVerified ? undefined : !canRun ? 'This hub can’t run agents.' : needsKey ? (unsetVars.length > 0 ? `Set a value for ${unsetVars.join(', ')} first (Edit).` : 'Add the API key first (Edit).') : detect.data?.found === false ? `${kind.binary} isn’t installed on the hub machine.` : undefined;

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
    <article className="panel provider-card provider" aria-label={s.label}>
      <div className="provider-top">
        <ProviderLogo kind={s.kind} />
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 'var(--s-2)' }}>
            <h3>{s.label}</h3>
            {s.label !== kind.label && <span className="badge">{kind.label}</span>}
            {kind.driverVerified ? <span className="badge good"><CircleCheck /> Can run agents</span> : <span className="badge">Setup only: driver not verified yet</span>}
          </div>
          <div className="faint xs" style={{ marginTop: 2 }}>
            {detect.busy && !detect.data ? 'Checking the hub machine…'
              : detect.data?.found ? <span className="row" style={{ gap: 6 }}><span className="status ok"><span className="dot" />{detect.data.version}</span><span className="mono">{detect.data.path}</span></span>
              : <span className="status bad"><span className="dot" />Not found{detect.data?.error ? `: ${detect.data.error}` : ''}</span>}
          </div>
        </div>
        <div className="actions">
          <button className="sm" onClick={runTest} disabled={test === 'running' || !kind.driverVerified}><KeyRound /> {test === 'running' ? 'Testing…' : 'Test sign-in'}</button>
          <button className="sm" onClick={() => setEditing(true)}><Pencil /> Edit</button>
          <button className="sm ghost danger" disabled={removing || provider.running > 0} title={provider.running > 0 ? 'Stop its agents first' : undefined} onClick={async () => { if (await remove({ providerId: provider.providerId })) toast(`${s.label} removed`); }}><Trash2 /> Remove</button>
        </div>
      </div>
      {(removeError || secretError) && <p className="error" style={{ padding: '0 var(--s-5) var(--s-3)' }}>{removeError ?? secretError}</p>}
      {test && test !== 'running' && (
        <p className={`result ${test.ok ? 'ok' : 'bad'}`} style={{ padding: '0 var(--s-5) var(--s-4)' }} role="status">
          {test.ok ? <CircleCheck /> : <CircleX />}{test.message}{test.ms > 0 && ` · ${duration(test.ms)}`}{test.costUsd !== null && ` · ${usd(test.costUsd)}`}
        </p>
      )}
      <div className="provider-grid">
        <div>
          <dl className="kv">
            <dt><Terminal /> Binary</dt><dd className="mono">{s.command || kind.binary}</dd>
            <dt><Cpu /> Model</dt><dd>{s.model || <span className="faint">CLI default</span>}{s.effort && <span className="faint"> · effort {s.effort}</span>}</dd>
            <dt><Bot /> Running</dt><dd className="num">{provider.running} of {s.maxInstances}</dd>
            {s.extraArgs.length > 0 && (<><dt>Arguments</dt><dd className="mono xs">{s.extraArgs.join(' ')}</dd></>)}
            {!detect.data?.found && detect.data && <><dt>Install</dt><dd><code>{kind.install}</code> <button className="link xs" onClick={() => void detect.run()}>Recheck</button></dd></>}
          </dl>
        </div>
        <div>
          <dl className="kv">
            <dt><KeyRound /> Sign-in</dt>
            <dd>{s.auth === 'cli-login' ? <>The CLI’s own login <div className="hint">{rich(kind.login)}</div></> : <>API key <span className="mono xs faint">{kind.apiKeyEnv}</span> {provider.hasSecret ? <span className="badge good"><CircleCheck /> set</span> : <span className="badge bad">not set</span>}</>}</dd>
            {((s.env ?? []).length > 0 || (s.secretEnv ?? []).length > 0) && (
              <>
                <dt><Variable /> Environment</dt>
                <dd className="env-list">
                  {(s.env ?? []).map((e) => <div key={e.name}><span>{e.name}</span>=<span className="muted">{e.value}</span></div>)}
                  {(s.secretEnv ?? []).map((n) => (
                    <div key={n}><span>{n}</span>={provider.secretsSet.includes(n) ? <span className="muted">•••••• (secret)</span> : <span className="verdict bad">not set</span>}</div>
                  ))}
                </dd>
              </>
            )}
          </dl>
        </div>
      </div>
      <div className="provider-foot">
        <div className="foot-bar">
          {kind.driverVerified ? (
            <>
              <button className="primary sm" onClick={onStart} disabled={!ready} title={reason}><Rocket /> Start agents</button>
              {reason && <span className="hint">{reason}</span>}
            </>
          ) : (
            <p className="small muted" style={{ maxWidth: '72ch' }}>Round Table doesn’t drive {kind.label} yet. To check it, run <code>node spikes/s8-drivers/check.mjs {kind.kind}</code> on the hub machine (where {kind.binary} is installed and logged in) and send back the report it makes. Your settings here are kept.</p>
          )}
        </div>
        {provider.agents.length > 0 && <ProviderAgents provider={provider} projects={projects} />}
      </div>
      <Sheet open={editing} onClose={() => setEditing(false)} title={`Edit ${s.label}`}>
        <ProviderForm kind={kind} provider={provider} onSaved={() => { toast('Changes saved'); setEditing(false); }} onCancel={() => setEditing(false)} />
      </Sheet>
    </article>
  );
}

function ProviderAgents({ provider, projects }: { provider: ProviderRecord; projects: ProjectSummary[] }) {
  const [setRun, busy] = useCommand('agent.run');
  const projectName = (id: string) => projects.find((p) => p.projectId === id)?.name ?? id;
  return (
    <div className="table-wrap" style={{ borderTop: '1px solid var(--border-soft)' }}>
      <table className="table">
        <thead><tr><th>Agent</th><th>Project</th><th>Status</th><th className="num">Cost</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {provider.agents.map((a) => (
            <tr key={a.agentId}>
              <td><span className="row" style={{ gap: 'var(--s-2)', flexWrap: 'nowrap' }}><Avatar name={a.name} seat={a.live?.status ?? 'stopped'} size="xs" /><strong>{a.name}</strong></span></td>
              <td><button className="link" onClick={() => go({ view: 'project', projectId: a.projectId })}><FolderGit2 size={13} style={{ marginRight: 4 }} />{projectName(a.projectId)}</button></td>
              <td><RunState live={a.live} />{a.live?.status === 'crashed' && a.live.lastError && <div className="xs faint">{a.live.lastError}</div>}</td>
              <td className="num">{usd(a.costUsd)}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {a.run && a.live?.status === 'crashed' && <button className="sm primary" disabled={busy} onClick={() => setRun({ projectId: a.projectId, agentId: a.agentId, run: true })} style={{ marginRight: 'var(--s-1)' }}><RotateCcw /> Restart</button>}
                {a.run
                  ? <button className="sm" disabled={busy} onClick={() => setRun({ projectId: a.projectId, agentId: a.agentId, run: false })}><Square /> Stop</button>
                  : <button className="sm" disabled={busy} onClick={() => setRun({ projectId: a.projectId, agentId: a.agentId, run: true })}><Play /> Start</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
