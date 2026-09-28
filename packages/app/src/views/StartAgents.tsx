import { useEffect, useId, useState } from 'react';
import { Minus, Plus, Rocket } from 'lucide-react';
import { go } from '../App.tsx';
import { useCommand, useQuery } from '../hub.tsx';
import type { ProjectSummary, ProviderKindDef, ProviderList, RosterRecord } from '../types.ts';
import { Sheet, useToast } from '../ui.tsx';

const NAMES = ['Ada', 'Bo', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kit', 'Lu', 'Max', 'Nia', 'Oz', 'Pia', 'Quin', 'Rae', 'Sol', 'Tam'];

import { ProviderLogo } from '../ui.tsx';
export { ProviderLogo };

/** Start agents from a provider into a project: pick both, then name one agent per seat. */
export function StartAgentsSheet({ open, onClose, projectId: fixedProject, providerId: fixedProvider }: { open: boolean; onClose: () => void; projectId?: string; providerId?: string }) {
  const id = useId();
  const { data: providers } = useQuery<ProviderList>('provider.list', {});
  const { data: projects } = useQuery<ProjectSummary[]>('project.list', {});
  const runnable = (providers?.providers ?? []).filter((p) => providers?.kinds.find((k) => k.kind === p.settings.kind)?.driverVerified);
  const [providerId, setProviderId] = useState(fixedProvider ?? '');
  const [projectId, setProjectId] = useState(fixedProject ?? '');
  useEffect(() => {
    if (open) {
      setProviderId(fixedProvider ?? runnable[0]?.providerId ?? '');
      setProjectId(fixedProject ?? projects?.[0]?.projectId ?? '');
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const provider = providers?.providers.find((p) => p.providerId === providerId);
  const kind: ProviderKindDef | undefined = providers?.kinds.find((k) => k.kind === provider?.settings.kind);
  const { data: roster } = useQuery<{ records: RosterRecord[] }>('board_read', projectId ? { section: 'roster', projectId } : undefined);
  const taken = new Set((roster?.records ?? []).filter((r) => r.state !== 'removed' && r.state !== 'left').map((r) => r.name.toLowerCase()));
  const free = provider ? Math.max(0, provider.settings.maxInstances - provider.running) : 0;
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    const suggested = NAMES.filter((n) => !taken.has(n.toLowerCase())).slice(0, Math.min(3, Math.max(1, free)));
    setNames(suggested);
  }, [open, projectId, providerId, roster?.records.length, free]); // eslint-disable-line react-hooks/exhaustive-deps
  // The first agent leads when the project has no leader yet, so its first turn plans.
  const hasLeader = (roster?.records ?? []).some((r) => r.role === 'leader' && r.state !== 'removed' && r.state !== 'left');
  const [leader, setLeader] = useState<string>('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  useEffect(() => {
    setModel('');
    setEffort('');
  }, [open, providerId]);
  const [spawn, spawning, error] = useCommand<{ started: Array<{ name: string }>; failed: Array<{ name: string; error: string }> }>('agent.spawn');
  const toast = useToast();
  const list = names.map((n) => n.trim()).filter(Boolean);
  const leaderName = hasLeader ? '' : leader === '-' ? '' : list.includes(leader) ? leader : list.length > 1 ? list[0]! : '';
  const setCount = (n: number) => {
    const count = Math.max(1, Math.min(10, n));
    const pool = NAMES.filter((x) => !taken.has(x.toLowerCase()) && !names.includes(x));
    setNames(count > names.length ? [...names, ...pool.slice(0, count - names.length)] : names.slice(0, count));
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Start agents"
      footer={(
        <>
          <button className="ghost" onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={spawning || !provider || !projectId || list.length === 0}
            onClick={async () => {
              const out = await spawn({ projectId, providerId, names: list, tags: [], ...(leaderName && { leader: leaderName }), ...(model.trim() && { model: model.trim() }), ...(effort && { effort }) });
              if (!out) return;
              if (out.started.length) toast(`Started ${out.started.map((s) => s.name).join(', ')}`);
              for (const f of out.failed) toast(`${f.name}: ${f.error}`, true);
              if (out.failed.length === 0) {
                onClose();
                go({ view: 'project', projectId, tab: 'table' });
              }
            }}
          >
            <Rocket /> {spawning ? 'Starting…' : `Start ${list.length} agent${list.length === 1 ? '' : 's'}`}
          </button>
        </>
      )}
    >
      {runnable.length === 0 ? (
        <div className="empty">
          <strong>No provider can run agents yet</strong>
          <p>Add Claude Code or the Antigravity CLI on the Agents page first.</p>
          <button className="primary" onClick={() => { onClose(); go({ view: 'agents' }); }}>Set up a provider</button>
        </div>
      ) : (
        <>
          {!fixedProvider && (
            <fieldset className="field">
              <legend className="label">Provider</legend>
              <div className="pick-grid">
                {runnable.map((p) => (
                  <button key={p.providerId} type="button" className="pick" aria-pressed={p.providerId === providerId} onClick={() => setProviderId(p.providerId)}>
                    <ProviderLogo kind={p.settings.kind} />
                    <span><strong>{p.settings.label}</strong><span className="faint xs" style={{ display: 'block' }}>{p.settings.model || 'default model'} · {p.running} of {p.settings.maxInstances} running</span></span>
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          {!fixedProject && (
            <div className="field">
              <label htmlFor={`${id}-project`}>Project</label>
              <select id={`${id}-project`} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {(projects ?? []).map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <span className="label">How many</span>
            <div className="row">
              <div className="stepper">
                <button type="button" aria-label="Fewer" onClick={() => setCount(names.length - 1)}><Minus /></button>
                <output aria-live="polite">{names.length}</output>
                <button type="button" aria-label="More" onClick={() => setCount(names.length + 1)}><Plus /></button>
              </div>
              <span className="hint">{provider ? `${free} of ${provider.settings.maxInstances} free on ${provider.settings.label}` : ''}</span>
            </div>
          </div>
          <div className="field">
            <span className="label">Names, one agent each</span>
            <div className="name-chips">
              {names.map((n, i) => (
                <span key={i} className="name-chip">
                  <label className="sr-only" htmlFor={`${id}-n${i}`}>Name {i + 1}</label>
                  <input id={`${id}-n${i}`} value={n} onChange={(e) => setNames(names.map((x, j) => (j === i ? e.target.value : x)))} />
                </span>
              ))}
            </div>
            <span className="hint">Each gets its own git worktree of the project’s repository.</span>
          </div>
          {!hasLeader && list.length > 1 && (
            <div className="field">
              <label htmlFor={`${id}-leader`}>Leader</label>
              <select id={`${id}-leader`} value={leaderName || '-'} onChange={(e) => setLeader(e.target.value)}>
                {list.map((n) => <option key={n} value={n}>{n} plans and coordinates</option>)}
                <option value="-">No leader: workers propose tasks themselves</option>
              </select>
              <span className="hint">The leader plans the goal in its first turn and commits the whole plan at once; it doesn’t write code.</span>
            </div>
          )}
          {kind && (
            <div className="grid-2">
              <div className="field">
                <label htmlFor={`${id}-model`}>Model</label>
                <input id={`${id}-model`} className="mono-input" list={`${id}-models`} value={model} placeholder={provider?.settings.model || 'provider’s default'} onChange={(e) => setModel(e.target.value)} />
                <datalist id={`${id}-models`}>{kind.models.map((m) => <option key={m} value={m} />)}</datalist>
              </div>
              {kind.efforts.length > 0 && (
                <div className="field">
                  <label htmlFor={`${id}-effort`}>Effort</label>
                  <select id={`${id}-effort`} value={effort} onChange={(e) => setEffort(e.target.value)}>
                    <option value="">{provider?.settings.effort ? `provider’s (${provider.settings.effort})` : 'provider’s default'}</option>
                    {kind.efforts.map((x) => <option key={x} value={x}>{x}</option>)}
                  </select>
                </div>
              )}
              <span className="hint" style={{ gridColumn: '1 / -1' }}>Empty: the provider’s, or the role’s default from Settings. You can change each agent later from the table.</span>
            </div>
          )}
          {kind && !kind.driverVerified && <p className="nudge">This CLI can’t be run by the hub yet.</p>}
          {error && <p className="error">{error}</p>}
        </>
      )}
    </Sheet>
  );
}
