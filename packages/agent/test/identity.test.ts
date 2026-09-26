import { describe, expect, it } from 'vitest';
import { identityPath, rtHome, hookSocketPath } from '../src/index.ts';

describe('identity slots', () => {
  it('resolves RT_HOME, then XDG_CONFIG_HOME', () => {
    expect(rtHome({ RT_HOME: '/x' })).toBe('/x');
    expect(rtHome({ XDG_CONFIG_HOME: '/cfg' })).toBe('/cfg/round-table');
  });

  it('keeps one identity file per hub and slot', () => {
    expect(identityPath('/h', 'hub1', 'worker-a')).toBe('/h/identities/hub1/worker-a.json');
    expect(hookSocketPath('/h', 'worker-a')).toBe('/h/run/worker-a.sock');
  });

  it('rejects slot names that could escape the directory', () => {
    for (const bad of ['../x', 'A', '', 'a/b', 'x'.repeat(40)]) expect(() => identityPath('/h', 'hub1', bad)).toThrow();
  });
});
