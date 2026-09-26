// Stands in for rt-agent's hook socket: answers every hook with "paused".
import { createServer } from 'node:net';
import { appendFileSync, rmSync } from 'node:fs';
const path = process.argv[2];
rmSync(path, { force: true });
createServer((c) => {
  let buf = '';
  c.on('data', (d) => {
    buf += d;
    if (!buf.includes('\n')) return;
    const req = JSON.parse(buf);
    appendFileSync(process.argv[3], `${new Date().toISOString()} hook ${req.hook_event_name} tool=${req.tool_name} input=${JSON.stringify(req.tool_input)}\n`);
    c.end(JSON.stringify({ decision: 'deny', reason: 'Round Table: project paused by the human. Commit WIP and call wait.' }) + '\n');
  });
}).listen(path);
