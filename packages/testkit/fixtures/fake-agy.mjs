#!/usr/bin/env node
// Plays agy 1.2.11 for driver tests, with the event shapes seen in the S8 check. Every invocation
// is appended to $FAKE_AGY_LOG. Prompts containing SLOW wait until SIGINT; FAILSTART exits at once.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_AGY_LOG, `${JSON.stringify(args)}\n`);
if (args[0] === 'mcp') process.exit(0);
const prompt = args[args.indexOf('-p') + 1] ?? '';
if (prompt.includes('FAILSTART')) {
  process.stderr.write('Not signed in. Run agy to sign in.\n');
  process.exit(1);
}
const i = args.indexOf('--conversation');
const conversation = i >= 0 ? args[i + 1] : randomUUID();
const out = (e) => process.stdout.write(`${JSON.stringify(e)}\n`);
out({ event: 'init', conversation_id: conversation, init: { cwd: process.cwd(), permission_mode: 'always-proceed' } });
const step = (s) => out({ event: 'step_update', step_update: { conversation_id: conversation, ...s } });
step({ step_index: 0, state: 'DONE', step_type: 'user_input' });
if (prompt.includes('SLOW')) {
  step({ step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { ServerName: 'rt-x', ToolName: 'fetch_plan', Arguments: {} } } });
  process.on('SIGINT', () => process.exit(130));
  setInterval(() => {}, 1000);
} else {
  step({ step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'call_mcp_tool', tool_info: { name: 'call_mcp_tool', parameters: { ServerName: 'rt-ada', ToolName: 'report', Arguments: { text: 'done' } } } });
  step({ step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'call_mcp_tool', duration_seconds: 0.01, tool_info: { name: 'call_mcp_tool', parameters: { ServerName: 'rt-ada', ToolName: 'report', Arguments: { text: 'done' } }, output: 'recorded' } });
  step({ step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'All ' });
  step({ step_index: 2, state: 'DONE', step_type: 'agent_response', text_delta: 'done.', duration_seconds: 1.5, usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 7, total_tokens: 15 } });
  out({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: 'All done. OK', duration_seconds: 2.5, usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 50 } } });
}
