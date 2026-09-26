import type { ProjectId } from '@round-table/protocol';
import { authorOf, makeEvent, SYSTEM } from '../event.ts';
import { accept, type CommandHandler } from '../module.ts';

export const createProject: CommandHandler<{ name: string }> = (_model, command, ctx) => {
  const projectId = ctx.ids.next('project') as ProjectId;
  return accept(
    [makeEvent(ctx, authorOf(command.principal), SYSTEM, 'project.created', { projectId, name: command.input.name })],
    { projectId },
  );
};
