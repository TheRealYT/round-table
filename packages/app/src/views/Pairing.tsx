import { useEffect, useId, useState } from 'react';
import { useCommand, useQuery } from '../hub.tsx';
import { shortId, timeAgo } from '../format.ts';
import type { PairedAgent, PairingRequest, ProjectSummary } from '../types.ts';

interface Allowed {
  code: string;
  expiresAt: number;
  projectId: string;
  requestId: string;
  name: string;
}

/** Spec: Pairing view. Check the phrase matches the agent's chat, allow into a project, paste the code there. */
export function PairingView({ onOpenProject }: { onOpenProject: (projectId: string) => void }) {
  const { data } = useQuery<{ requests: PairingRequest[]; agents: PairedAgent[] }>('pairing.list', {});
  const { data: projects } = useQuery<ProjectSummary[]>('project.list', {});
  const [allowed, setAllowed] = useState<Allowed>();
  const pending = (data?.requests ?? []).filter((r) => r.status === 'pending');

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">Agents you run yourself</div>
          <h1>Pairing</h1>
          <p className="lede">For agents you run yourself in an IDE or chat app. The agent shows a match phrase in its chat; check it matches here, allow it, and paste the code into that chat. Agents the hub runs for you need none of this: start them from Agents.</p>
        </div>
      </header>

      {allowed && <CodeCard allowed={allowed} onDone={() => { setAllowed(undefined); onOpenProject(allowed.projectId); }} />}

      <section>
        <div className="section-head"><h2>Join requests</h2>{pending.length > 0 && <span className="badge">{pending.length}</span>}</div>
        {pending.length === 0 && <p className="empty">No agents are waiting. In an agent's chat, ask it to join the Round Table.</p>}
        <div className="cards">
          {pending.map((r) => (
            <RequestCard key={r.requestId} request={r} projects={projects ?? []} agents={data?.agents ?? []} onAllowed={(a) => setAllowed({ ...a, requestId: r.requestId, name: r.name })} />
          ))}
        </div>
      </section>

      <section>
        <div className="section-head"><h2>Paired agents</h2></div>
        {(data?.agents ?? []).length === 0 ? (
          <p className="empty">None yet.</p>
        ) : (
          <div className="panel table-wrap"><table className="table">
            <thead>
              <tr><th>Agent</th><th>Project</th><th>Role</th><th>State</th><th>Key</th><th>Paired</th></tr>
            </thead>
            <tbody>
              {data?.agents.map((a) => (
                <tr key={a.agentId}>
                  <td><strong>{a.name}</strong> <span className="mono muted">{shortId(a.agentId)}</span><div className="muted small">{a.client}</div></td>
                  <td><button className="link" onClick={() => onOpenProject(a.projectId)}>{projects?.find((p) => p.projectId === a.projectId)?.name ?? shortId(a.projectId)}</button></td>
                  <td>{a.role}</td>
                  <td><StateDot state={a.state} connected={a.connected} /></td>
                  <td className="mono small">{a.fingerprint}</td>
                  <td className="muted small">{timeAgo(a.pairedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}

function RequestCard({ request, projects, agents, onAllowed }: { request: PairingRequest; projects: ProjectSummary[]; agents: PairedAgent[]; onAllowed: (a: { code: string; expiresAt: number; projectId: string }) => void }) {
  const [target, setTarget] = useState<string>(projects[0]?.projectId ?? 'new');
  const [newName, setNewName] = useState('');
  const [allow, allowing, allowError] = useCommand<{ code: string; expiresAt: number; projectId: string }>('pairing.allow');
  const [deny] = useCommand('pairing.deny');
  const [block] = useCommand('pairing.block_origin');
  const resumes = request.resumes === null ? undefined : agents.find((a) => a.agentId === request.resumes);
  const isNew = !resumes && target === 'new';
  const id = useId();

  return (
    <article className="panel request-card request">
      <div className="phrase" aria-label="match phrase">{request.matchPhrase}</div>
      {resumes && (
        <p className="nudge urgent" role="note">
          A new chat asks to continue as <strong>{resumes.name}</strong> (already paired, in {projects.find((p) => p.projectId === resumes.projectId)?.name ?? shortId(resumes.projectId)}).
          Allow it only if you opened this chat for {resumes.name}. The chat working as {resumes.name} now will be stopped.
        </p>
      )}
      <dl className="facts-list">
        <dt>Name</dt><dd>{request.name}</dd>
        <dt>Client</dt><dd>{request.client}</dd>
        <dt>Origin</dt><dd className="mono">{request.origin}</dd>
        <dt>Key</dt><dd className="mono small">{request.fingerprint}</dd>
        {request.tags.length > 0 && (<><dt>Tags</dt><dd>{request.tags.join(', ')}</dd></>)}
        <dt>Asked</dt><dd>{timeAgo(request.requestedAt)}</dd>
      </dl>
      {!resumes && <div className="field">
        <label htmlFor={`${id}-project`}>Project</label>
        <select id={`${id}-project`} value={target} onChange={(e) => setTarget(e.target.value)}>
          {projects.map((p) => <option key={p.projectId} value={p.projectId}>{p.name}</option>)}
          <option value="new">New project…</option>
        </select>
      </div>}
      {isNew && (
        <div className="field">
          <label htmlFor={`${id}-name`}>New project name</label>
          <input id={`${id}-name`} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Checkout redesign" />
        </div>
      )}
      {allowError && <p className="error">{allowError}</p>}
      <div className="actions">
        <button
          className="primary"
          disabled={allowing || (isNew && newName.trim() === '')}
          onClick={async () => {
            const out = await allow(resumes ? { requestId: request.requestId } : isNew ? { requestId: request.requestId, newProjectName: newName.trim() } : { requestId: request.requestId, projectId: target });
            if (out) onAllowed(out);
          }}
        >
          {resumes ? `Phrase matches, allow as ${resumes.name}` : 'Phrase matches, allow'}
        </button>
        <button onClick={() => deny({ requestId: request.requestId })}>Deny</button>
        <button className="danger" title="Deny and refuse future requests from this origin" onClick={() => block({ origin: request.origin })}>Block origin</button>
      </div>
    </article>
  );
}

function CodeCard({ allowed, onDone }: { allowed: Allowed; onDone: () => void }) {
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.round((allowed.expiresAt - now) / 1000));
  return (
    <section className="panel code-card" role="status">
      <h2>Paste this code into {allowed.name}'s chat</h2>
      <div className="code" data-testid="pairing-code">{allowed.code}</div>
      <p className="muted">
        {left > 0 ? `Valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}, one use.` : 'Expired: deny and ask the agent to request again.'} The code only works in the chat that shows the matching phrase.
      </p>
      <div className="actions">
        <button
          className="primary"
          onClick={async () => {
            await navigator.clipboard?.writeText(allowed.code);
            setCopied(true);
          }}
        >
          {copied ? 'Copied' : 'Copy code'}
        </button>
        <button onClick={onDone}>Done, open project</button>
      </div>
    </section>
  );
}

export function StateDot({ state, connected }: { state: string | null; connected: boolean }) {
  const label = state === 'active' ? (connected ? 'connected' : 'reconnecting') : (state ?? 'unknown');
  const tone = state === 'active' && connected ? 'ok' : state === 'active' || state === 'stale' ? 'warn' : 'off';
  return <span className={`status ${tone}`}><span className="dot" aria-hidden />{label}</span>;
}
