import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { Bell, Bot, Coins, Gauge, MessagesSquare, RotateCcw, ScrollText, Settings as SettingsIcon, SquareTerminal } from 'lucide-react';
import { useCommand, useQuery } from '../hub.tsx';
import type { ProviderList } from '../types.ts';
import { useToast } from '../ui.tsx';

type Leaf = string | number | boolean;
type Overrides = Record<string, Record<string, Leaf> | undefined>;
interface SettingsData {
  defaults: Record<string, Record<string, Leaf>>;
  hub: Overrides;
  project: Overrides;
  resolved: Record<string, Record<string, Leaf>>;
}

interface Field {
  group: string;
  key: string;
  label: string;
  help?: string;
  kind: 'select' | 'toggle' | 'usd' | 'text' | 'textarea' | 'model' | 'effort';
  options?: Array<{ value: string; label: string }>;
  /** Only hub-wide (projects don't override it). */
  hubOnly?: boolean;
}

interface Group {
  id: string;
  title: string;
  icon: ReactNode;
  about: string;
  fields: Field[];
  hubOnly?: boolean;
}

const GROUPS: Group[] = [
  {
    id: 'autonomy',
    title: 'Autonomy',
    icon: <Gauge />,
    about: 'How much the team does without you.',
    fields: [
      {
        group: 'autonomy',
        key: 'planApproval',
        label: 'Who approves the plan',
        kind: 'select',
        options: [
          { value: 'human', label: 'You approve it in the app' },
          { value: 'leader', label: 'The leader approves it (full auto)' },
        ],
        help: 'In full auto the leader’s plan is ready at once and the workers start; you still see everything and can stop any agent.',
      },
    ],
  },
  {
    id: 'budget',
    title: 'Budget',
    icon: <Coins />,
    about: 'A ceiling on what a project’s hub-run agents spend.',
    fields: [{ group: 'budget', key: 'projectUsd', label: 'Stop a project’s agents at', kind: 'usd', help: 'You are warned at 80%. At 100% the hub stops the project’s agents; raise the limit and start them again. 0 means no limit.' }],
  },
  {
    id: 'messaging',
    title: 'Messages',
    icon: <MessagesSquare />,
    about: 'Agents talk to whoever needs it; messages to everyone never wake the whole team.',
    fields: [
      {
        group: 'messaging',
        key: 'workerBroadcast',
        label: 'A worker’s message to everyone',
        kind: 'select',
        options: [
          { value: 'fyi', label: 'Delivered as an FYI with each agent’s next turn' },
          { value: 'off', label: 'Refused: workers must name the recipients' },
        ],
      },
    ],
  },
  {
    id: 'agents',
    title: 'Agent defaults',
    icon: <Bot />,
    about: 'Model and effort per role for hub-run agents that have no choice of their own. Empty: the provider’s.',
    fields: [
      { group: 'agents', key: 'leaderModel', label: 'Leader model', kind: 'model' },
      { group: 'agents', key: 'leaderEffort', label: 'Leader effort', kind: 'effort', help: 'Planning and reviewing proposals rarely needs the highest effort.' },
      { group: 'agents', key: 'workerModel', label: 'Worker model', kind: 'model' },
      { group: 'agents', key: 'workerEffort', label: 'Worker effort', kind: 'effort' },
    ],
  },
  {
    id: 'rules',
    title: 'Rules for every project',
    icon: <ScrollText />,
    about: 'Agents get these with their instructions; each project adds its own under Setup.',
    hubOnly: true,
    fields: [
      { group: 'rules', key: 'team', label: 'Team rules', kind: 'textarea', help: 'e.g. conventions, what not to touch, how to write commits.', hubOnly: true },
      { group: 'rules', key: 'leader', label: 'Leader rules', kind: 'textarea', help: 'Only the leader gets these: how to plan, what to approve, when to ask you.', hubOnly: true },
    ],
  },
  {
    id: 'notifications',
    title: 'Notifications',
    icon: <Bell />,
    about: 'Browser notifications while the app is open in a tab.',
    hubOnly: true,
    fields: [
      { group: 'notifications', key: 'needsYou', label: 'When something needs you', kind: 'toggle', help: 'Plan approvals, pairing requests, crashed agents, budget alerts.', hubOnly: true },
      { group: 'notifications', key: 'critical', label: 'Critical alerts', kind: 'toggle', hubOnly: true },
    ],
  },
  {
    id: 'tools',
    title: 'Tools',
    icon: <SquareTerminal />,
    about: 'What the app lets you do on the hub machine.',
    hubOnly: true,
    fields: [{ group: 'tools', key: 'terminal', label: 'Terminal in the app', kind: 'toggle', help: 'A shell on the hub machine, in the repository or an agent’s worktree.', hubOnly: true }],
  },
];

export function SettingsView() {
  return (
    <div className="page narrow">
      <header className="page-head">
        <div>
          <div className="eyebrow row faint small" style={{ gap: 6, marginBottom: 'var(--s-2)' }}><SettingsIcon size={14} /> Settings</div>
          <h1>Settings</h1>
          <p className="muted">Hub-wide defaults. Each project can override them under its Setup tab.</p>
        </div>
      </header>
      <SettingsForm scope="hub" />
    </div>
  );
}

/** Hub-wide settings, or a project's overrides (with what it would inherit shown and a reset). */
export function SettingsForm({ scope, projectId }: { scope: 'hub' | 'project'; projectId?: string }) {
  const id = useId();
  const { data } = useQuery<SettingsData>('settings.get', projectId ? { projectId } : {});
  const { data: providers } = useQuery<ProviderList>('provider.list', {});
  const [draft, setDraft] = useState<Overrides>({});
  const saved = scope === 'hub' ? data?.hub : data?.project;
  useEffect(() => {
    if (saved) setDraft(JSON.parse(JSON.stringify(saved)) as Overrides);
  }, [JSON.stringify(saved)]); // eslint-disable-line react-hooks/exhaustive-deps
  const [save, saving, error] = useCommand('settings.set');
  const toast = useToast();
  const models = useMemo(() => [...new Set((providers?.kinds ?? []).flatMap((k) => k.models ?? []))], [providers]);
  const efforts = useMemo(() => {
    const all = (providers?.kinds ?? []).filter((k) => providers?.providers.some((p) => p.settings.kind === k.kind)).flatMap((k) => k.efforts ?? []);
    return ['low', 'medium', 'high', 'xhigh', 'max'].filter((e) => all.includes(e));
  }, [providers]);
  if (!data) return null;

  const inherited = (f: Field): Leaf => {
    const base = data.defaults[f.group]?.[f.key] as Leaf;
    return scope === 'project' ? ((data.hub[f.group]?.[f.key] as Leaf | undefined) ?? base) : base;
  };
  const value = (f: Field): Leaf => (draft[f.group]?.[f.key] as Leaf | undefined) ?? inherited(f);
  const overridden = (f: Field) => draft[f.group]?.[f.key] !== undefined;
  const set = (f: Field, v: Leaf | undefined) => {
    const next: Overrides = { ...draft, [f.group]: { ...(draft[f.group] ?? {}) } };
    if (v === undefined) delete next[f.group]![f.key];
    else next[f.group]![f.key] = v;
    if (Object.keys(next[f.group]!).length === 0) delete next[f.group];
    setDraft(next);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved ?? {});
  const groups = GROUPS.filter((g) => scope === 'hub' || !g.hubOnly);

  return (
    <form
      className="settings"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await save({ scope, ...(projectId && { projectId }), overrides: draft })) toast(scope === 'hub' ? 'Settings saved' : 'Project settings saved');
      }}
    >
      {groups.map((g) => (
        <section key={g.id} className="panel settings-group">
          <div className="panel-head">{g.icon}<h2>{g.title}</h2><span className="faint xs head-note">{g.about}</span></div>
          <div className="settings-fields">
            {g.fields.map((f) => {
              const fid = `${id}-${f.group}-${f.key}`;
              const v = value(f);
              const inheritedText = scope === 'project' ? describe(f, inherited(f)) : null;
              return (
                <div key={fid} className={`setting ${f.kind === 'textarea' ? 'wide' : ''}`}>
                  <div className="setting-label">
                    <label htmlFor={fid}>{f.label}</label>
                    {f.help && <span className="hint">{f.help}</span>}
                  </div>
                  <div className="setting-control">
                    {f.kind === 'select' && (
                      <select id={fid} value={String(v)} onChange={(e) => set(f, e.target.value)}>
                        {f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    )}
                    {f.kind === 'toggle' && (
                      <label className="switch"><input id={fid} type="checkbox" checked={Boolean(v)} onChange={(e) => set(f, e.target.checked)} /><span aria-hidden /> {v ? 'On' : 'Off'}</label>
                    )}
                    {f.kind === 'usd' && (
                      <div className="input-affix"><span>$</span><input id={fid} type="number" min={0} step={0.5} value={Number(v)} onChange={(e) => set(f, Math.max(0, Number(e.target.value) || 0))} /></div>
                    )}
                    {f.kind === 'model' && (
                      <>
                        <input id={fid} className="mono-input" list={`${id}-models`} value={String(v)} placeholder="provider’s model" onChange={(e) => set(f, e.target.value.trim())} />
                        <datalist id={`${id}-models`}>{models.map((m) => <option key={m} value={m} />)}</datalist>
                      </>
                    )}
                    {f.kind === 'effort' && (
                      <select id={fid} value={String(v)} onChange={(e) => set(f, e.target.value)}>
                        <option value="">Provider’s default</option>
                        {efforts.map((e) => <option key={e} value={e}>{e}</option>)}
                      </select>
                    )}
                    {f.kind === 'textarea' && <textarea id={fid} rows={4} value={String(v)} onChange={(e) => set(f, e.target.value)} />}
                    {scope === 'project' && (
                      overridden(f)
                        ? <button type="button" className="ghost sm" onClick={() => set(f, undefined)} title="Use the hub-wide value"><RotateCcw /> Hub: {inheritedText}</button>
                        : <span className="faint xs">from the hub</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      <div className={`settings-save ${dirty ? "dirty" : ""}`}>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary" disabled={saving || !dirty}>{saving ? 'Saving…' : dirty ? 'Save settings' : 'Saved'}</button>
      </div>
    </form>
  );
}

function describe(f: Field, v: Leaf): string {
  if (f.kind === 'toggle') return v ? 'on' : 'off';
  if (f.kind === 'usd') return Number(v) > 0 ? `$${v}` : 'no limit';
  if (f.kind === 'select') return f.options?.find((o) => o.value === v)?.label.split(' ')[1] ?? String(v);
  return String(v) || 'provider’s';
}
