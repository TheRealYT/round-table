import { describe, expect, it } from 'vitest';
import { translateClaudeEvent } from '@round-table/hub';

describe('Claude Code stream-json → driver events', () => {
  it('keeps thinking, full tool inputs, tool results and text', () => {
    const assistant = {
      type: 'assistant',
      message: { content: [
        { type: 'thinking', thinking: 'Check the README first.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/README.md' } },
        { type: 'text', text: 'Reading it.' },
      ] },
    };
    expect(translateClaudeEvent(assistant)).toEqual([
      { type: 'thinking', text: 'Check the README first.' },
      { type: 'tool', id: 'toolu_1', name: 'Read', input: '{"file_path":"/repo/README.md"}' },
      { type: 'text', text: 'Reading it.' },
    ]);
    const user = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '# sample' }], is_error: false }] } };
    expect(translateClaudeEvent(user)).toEqual([{ type: 'tool_result', id: 'toolu_1', output: '# sample', isError: false }]);
    const big = translateClaudeEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'a'.repeat(25_000), is_error: true }] } })[0] as { output: string; isError: boolean };
    expect(big.output.length).toBeLessThan(21_000);
    expect(big.output).toContain('5000 more characters');
    expect(big.isError).toBe(true);
  });
});
