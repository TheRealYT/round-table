import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowDownToLine, Bot, Brain, ChevronRight, CircleCheck, CircleX, FilePen, FileText, FolderOpen, Globe, ListTodo, LoaderCircle,
  Radio, Search, SquareTerminal, Wrench,
} from 'lucide-react';
import { BrandMark } from '../App.tsx';
import { useHub } from '../hub.tsx';
import { clock, duration, tokens, usd } from '../format.ts';
import type { LiveState, RosterRecord, TranscriptEntry } from '../types.ts';
import { initials } from '../ui.tsx';

/**
 * A hub-run agent's whole session, read like an AI chat: what the Round Table told it, its thinking,
 * every tool call with its input and result, what it said, and where each turn ended. Fetched
 * incrementally from the hub's step log, so it keeps up live and survives hub restarts.
 */
export function AgentLog({ projectId, agent }: { projectId: string; agent: RosterRecord }) {
  const client = useHub();
  const [entries, setEntries] = useState<TranscriptEntry[]>([]);
  const [live, setLive] = useState<LiveState | null>(agent.driven?.live ?? null);
  const [show, setShow] = useState({ thinking: true, tools: true, hub: true });
  const [follow, setFollow] = useState(true);
  const last = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!client) return;
    let stopped = false;
    last.current = 0;
    setEntries([]);
    const pull = async () => {
      try {
        const out = await client.call<{ entries: TranscriptEntry[]; live: LiveState | null }>('agent.transcript', { projectId, agentId: agent.agentId, after: last.current, limit: last.current ? 500 : 800 });
        if (stopped) return;
        setLive(out.live);
        if (out.entries.length) {
          last.current = out.entries.at(-1)!.id;
          setEntries((prev) => [...prev, ...out.entries].slice(-3000));
        }
      } catch {
        // the hub is briefly unreachable; the next pull catches up
      }
    };
    void pull();
    const t = setInterval(pull, 1_200);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [client, projectId, agent.agentId]);

  useEffect(() => {
    const el = box.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [entries.length, follow, live?.status]);

  const items = useMemo(() => build(entries), [entries]);
  const visible = items.filter((i) => (i.kind === 'thinking' ? show.thinking : i.kind === 'tool' ? show.tools : i.kind === 'hub' ? show.hub : true));
  const toolCount = items.filter((i) => i.kind === 'tool').length;

  return (
    <section className="panel session" aria-label={`${agent.name} session`}>
      <div className="panel-head">
        <span className={`avatar xs ${live?.status ?? ''}`} aria-hidden>{initials(agent.name)}</span>
        <h2>{agent.name}’s session</h2>
        <span className="faint xs">{items.filter((i) => i.kind === 'turn').length} turns · {toolCount} tool calls</span>
        <div className="actions">
          <label className="toggle"><input type="checkbox" checked={show.thinking} onChange={(e) => setShow({ ...show, thinking: e.target.checked })} /> Thinking</label>
          <label className="toggle"><input type="checkbox" checked={show.tools} onChange={(e) => setShow({ ...show, tools: e.target.checked })} /> Tools</label>
          <label className="toggle"><input type="checkbox" checked={show.hub} onChange={(e) => setShow({ ...show, hub: e.target.checked })} /> Hub messages</label>
          <button className={`sm ${follow ? '' : 'ghost'}`} aria-pressed={follow} onClick={() => setFollow(!follow)} title="Keep scrolled to the newest step"><ArrowDownToLine /> Follow</button>
        </div>
      </div>
      <div
        className="log"
        ref={box}
        aria-label={`${agent.name} transcript`}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          if (atBottom !== follow) setFollow(atBottom);
        }}
      >
        {visible.length === 0 && <p className="faint small" style={{ padding: 'var(--s-5)' }}>No steps yet. They appear here as soon as {agent.name} starts.</p>}
        {visible.map((item) => <Fragment key={item.key}>{render(item, agent.name, live)}</Fragment>)}
        {live?.status === 'working' && (
          <div className="log-live" role="status">
            <LoaderCircle className="spinning" />
            <span>{agent.name} is working{live.tool ? <> — <span className="mono">{describeTool(live.tool, '{}').verb.toLowerCase()} {toolLabel(live.tool)}</span></> : ''}</span>
            <span className="dots" aria-hidden><i /><i /><i /></span>
          </div>
        )}
      </div>
    </section>
  );
}

// ── building the view ─────────────────────────────────────────────────────────────────

type Item =
  | { kind: 'hub' | 'thinking' | 'text' | 'status' | 'turn'; key: string; entry: TranscriptEntry }
  | { kind: 'tool'; key: string; call: TranscriptEntry; result: TranscriptEntry | null };

function build(entries: TranscriptEntry[]): Item[] {
  const items: Item[] = [];
  const open = new Map<string, Extract<Item, { kind: 'tool' }>>();
  for (const e of entries) {
    if (e.kind === 'tool') {
      const item = { kind: 'tool' as const, key: `t${e.id}`, call: e, result: null };
      items.push(item);
      open.set(String(e.data?.id ?? `n${e.id}`), item);
    } else if (e.kind === 'tool_result') {
      const id = String(e.data?.id ?? '');
      const match = open.get(id) ?? [...open.values()].find((t) => !t.result);
      if (match) {
        match.result = e;
        open.delete(id);
      } else {
        items.push({ kind: 'status', key: `r${e.id}`, entry: { ...e, text: `tool result: ${e.text.slice(0, 200)}` } });
      }
    } else if (e.kind === 'turn') {
      items.push({ kind: 'turn', key: `u${e.id}`, entry: e });
      open.clear();
    } else {
      items.push({ kind: e.kind === 'to_agent' ? 'hub' : e.kind, key: `${e.kind}${e.id}`, entry: e });
    }
  }
  return items;
}

function render(item: Item, name: string, live: LiveState | null): ReactNode {
  switch (item.kind) {
    case 'hub': return <HubMessage entry={item.entry} name={name} />;
    case 'thinking': return <Thinking entry={item.entry} />;
    case 'text': return <Reply entry={item.entry} name={name} />;
    case 'tool': return <ToolCard call={item.call} result={item.result} pending={!item.result && live?.status === 'working'} />;
    case 'turn': return <TurnEnd entry={item.entry} />;
    case 'status': return <p className="log-status"><Radio />{item.entry.text}<time>{clock(item.entry.at)}</time></p>;
  }
}

function HubMessage({ entry, name }: { entry: TranscriptEntry; name: string }) {
  const [open, setOpen] = useState(false);
  const long = entry.text.length > 420;
  return (
    <div className="log-hub">
      <span className="log-avatar hub" aria-hidden><BrandMark /></span>
      <div className="log-main">
        <div className="log-who"><b>Round Table</b> → {name}<time>{clock(entry.at)}</time></div>
        <div className={`log-hub-body ${long && !open ? 'clamped' : ''}`}><Rich text={entry.text} /></div>
        {long && <button className="link xs" onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show all'}</button>}
      </div>
    </div>
  );
}

function Thinking({ entry }: { entry: TranscriptEntry }) {
  const tokensUsed = Number(entry.data?.tokens ?? 0);
  if (!entry.text.trim()) {
    return <p className="log-thinking-empty"><Brain />Thought{tokensUsed ? ` (${tokens(tokensUsed)} thinking tokens)` : ''}<time>{clock(entry.at)}</time></p>;
  }
  const first = entry.text.trim().split('\n')[0]!;
  return (
    <details className="log-thinking">
      <summary><Brain /><span>Thinking</span><span className="preview">{first.length > 110 ? `${first.slice(0, 110)}…` : first}</span><ChevronRight className="chev" /><time>{clock(entry.at)}</time></summary>
      <div className="log-thinking-body">{entry.text}</div>
    </details>
  );
}

function Reply({ entry, name }: { entry: TranscriptEntry; name: string }) {
  return (
    <div className="log-reply">
      <span className="log-avatar" aria-hidden>{initials(name)}</span>
      <div className="log-main">
        <div className="log-who"><b>{name}</b><time>{clock(entry.at)}</time></div>
        <div className="log-reply-body"><Rich text={entry.text} /></div>
      </div>
    </div>
  );
}

function TurnEnd({ entry }: { entry: TranscriptEntry }) {
  const d = entry.data ?? {};
  const ok = d.ok !== false;
  const parts = [
    typeof d.durationMs === 'number' ? duration(d.durationMs) : null,
    typeof d.costUsd === 'number' ? usd(d.costUsd) : null,
    typeof d.tokens === 'number' && d.tokens > 0 ? `${tokens(d.tokens)} tokens` : null,
  ].filter(Boolean);
  return (
    <div className={`log-turn ${ok ? '' : 'bad'}`}>
      <span>{ok ? <CircleCheck /> : <CircleX />}{ok ? 'Turn finished' : `Turn ended: ${String(d.error ?? 'error')}`}{parts.length ? ` · ${parts.join(' · ')}` : ''}</span>
    </div>
  );
}

// ── tools ─────────────────────────────────────────────────────────────────────────────

interface ToolView { verb: string; target: string; icon: ReactNode; rt?: boolean }

function toolLabel(name: string): string {
  const m = /^mcp__([^_]+(?:[_-][^_]+)*?)__(.+)$/.exec(name);
  return m ? m[2]! : name;
}

function parse(input: string): Record<string, unknown> {
  try {
    const v = JSON.parse(input) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A tool call as a short, human sentence: "Read src/cart.tsx", "Ran npm test". Claude Code and agy names. */
export function describeTool(name: string, input: string): ToolView {
  const a = parse(input);
  const s = (...keys: string[]) => {
    for (const k of keys) if (typeof a[k] === 'string' && a[k]) return a[k] as string;
    return '';
  };
  if (name.startsWith('mcp__')) {
    const tool = toolLabel(name);
    const detail = s('section', 'view', 'id', 'taskId', 'requestId', 'kind', 'to', 'doing') || (typeof a.text === 'string' ? a.text : '');
    return { verb: 'Round Table', target: `${tool}${detail ? ` · ${detail}` : ''}`, icon: <BrandMark />, rt: true };
  }
  switch (name) {
    case 'Read': case 'view_file': case 'NotebookRead': return { verb: 'Read', target: s('file_path', 'AbsolutePath', 'path'), icon: <FileText /> };
    case 'Write': case 'write_to_file': return { verb: 'Wrote', target: s('file_path', 'TargetFile', 'path'), icon: <FilePen /> };
    case 'Edit': case 'MultiEdit': case 'replace_file_content': case 'multi_replace_file_content': case 'sed_file': case 'NotebookEdit': case 'notebook_edit':
      return { verb: 'Edited', target: s('file_path', 'TargetFile', 'AbsolutePath', 'path', 'notebook_path'), icon: <FilePen /> };
    case 'Bash': case 'run_command': case 'BashOutput': case 'send_command_input': return { verb: 'Ran', target: s('command', 'CommandLine', 'Input', 'bash_id'), icon: <SquareTerminal /> };
    case 'Grep': case 'grep_search': return { verb: 'Searched for', target: s('pattern', 'Query', 'query'), icon: <Search /> };
    case 'Glob': case 'LS': case 'find_by_name': case 'list_dir': return { verb: 'Listed', target: s('pattern', 'Pattern', 'path', 'DirectoryPath', 'SearchDirectory'), icon: <FolderOpen /> };
    case 'WebFetch': case 'read_url_content': case 'WebSearch': case 'search_web': return { verb: 'Browsed', target: s('url', 'Url', 'query', 'Query'), icon: <Globe /> };
    case 'TodoWrite': case 'manage_task': return { verb: 'Updated the to-do list', target: '', icon: <ListTodo /> };
    case 'ToolSearch': return { verb: 'Loaded tools', target: s('query'), icon: <Search /> };
    case 'Task': case 'invoke_subagent': return { verb: 'Asked a subagent', target: s('description', 'prompt'), icon: <Bot /> };
    default: return { verb: name, target: Object.values(a).find((v) => typeof v === 'string' && v.length < 120) as string ?? '', icon: <Wrench /> };
  }
}

function ToolCard({ call, result, pending }: { call: TranscriptEntry; result: TranscriptEntry | null; pending: boolean }) {
  const name = String(call.data?.name ?? call.text);
  const input = String(call.data?.input ?? '{}');
  const view = describeTool(name, input);
  const failed = result?.data?.isError === true;
  const args = parse(input);
  const command = typeof args.command === 'string' ? args.command : typeof args.CommandLine === 'string' ? args.CommandLine : null;
  const edit = typeof args.old_string === 'string' && typeof args.new_string === 'string' ? { old: args.old_string, new: args.new_string } : null;
  return (
    <details className={`log-tool ${view.rt ? 'rt' : ''} ${failed ? 'bad' : ''}`}>
      <summary>
        <span className="tool-icon">{view.icon}</span>
        <span className="tool-line"><b>{view.verb}</b> {view.target && <span className="mono">{view.target}</span>}</span>
        <span className="tool-state">{pending ? <LoaderCircle className="spinning" /> : result ? (failed ? <CircleX /> : <CircleCheck />) : null}</span>
        <time>{clock(call.at)}</time>
        <ChevronRight className="chev" />
      </summary>
      <div className="tool-detail">
        <div className="tool-block">
          <div className="tool-block-label">{command ? 'Command' : edit ? 'Change' : 'Input'}</div>
          {command ? <pre className="code"><span className="prompt">$ </span>{command}</pre>
            : edit ? <pre className="code diff">{edit.old.split('\n').map((l, i) => <span key={`o${i}`} className="del">- {l}{'\n'}</span>)}{edit.new.split('\n').map((l, i) => <span key={`n${i}`} className="add">+ {l}{'\n'}</span>)}</pre>
            : <pre className="code">{pretty(input)}</pre>}
        </div>
        <div className="tool-block">
          <div className="tool-block-label">{failed ? 'Error' : 'Output'}{result && <span className="faint"> · {clock(result.at)}</span>}</div>
          {result ? <pre className={`code ${failed ? 'err' : ''}`}>{result.text || '(no output)'}</pre> : <p className="faint xs">{pending ? 'Waiting for the result…' : 'No result recorded.'}</p>}
        </div>
      </div>
    </details>
  );
}

function pretty(input: string): string {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
}

/** Just enough markdown for agent text: code fences, inline code, bold. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/```(?:[\w-]*)\n?([\s\S]*?)```/g);
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1
        ? <pre key={i} className="code">{part.replace(/\n$/, '')}</pre>
        : <span key={i}>{part.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((seg, j) => (seg.startsWith('`') && seg.endsWith('`') && seg.length > 1 ? <code key={j}>{seg.slice(1, -1)}</code> : seg.startsWith('**') && seg.endsWith('**') ? <b key={j}>{seg.slice(2, -2)}</b> : seg))}</span>))}
    </>
  );
}
