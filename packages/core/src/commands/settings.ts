import type { ProjectId, SettingsOverrides } from '@round-table/protocol';
import { authorOf, makeEvent, SYSTEM } from '../event.ts';
import { accept, reject, type CommandHandler } from '../module.ts';

/** The human sets a scope's settings (S2c): the hub's defaults, or one project's overrides. */
export const setSettings: CommandHandler<{ scope: 'hub' | 'project'; projectId?: ProjectId; overrides: SettingsOverrides }> = (model, command, ctx) => {
  if (command.principal.kind !== 'human') return reject('forbidden', 'human only');
  const { scope, projectId, overrides } = command.input;
  if (scope === 'project' && (!projectId || !model.projects[projectId])) return reject('unknown_project', 'no such project');
  return accept([makeEvent(ctx, authorOf(command.principal), SYSTEM, 'settings.changed', { scope, projectId: scope === 'project' ? projectId! : null, overrides })]);
};
