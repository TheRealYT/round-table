// The shape of `rt hook pre-tool-use`: stdin JSON -> unix socket -> hook JSON on stdout. Fails open.
import { connect } from 'node:net';
const started = performance.now();
let input = '';
for await (const chunk of process.stdin) input += chunk;
const sock = connect(process.env.RT_HOOK_SOCK);
let reply = '';
sock.on('data', (d) => (reply += d));
sock.on('error', () => process.exit(0)); // fail open
sock.on('end', () => {
  const { decision, reason } = JSON.parse(reply);
  process.stderr.write(`hook latency ${(performance.now() - started).toFixed(1)} ms\n`);
  if (decision === 'deny') {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  }
  process.exit(0);
});
sock.write(JSON.stringify(JSON.parse(input)) + '\n');
