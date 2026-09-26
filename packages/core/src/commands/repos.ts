import type { ProjectId, RepoId } from '@round-table/protocol';
import { authorOf, inProject, makeEvent, SYSTEM } from '../event.ts';
import { accept, reject, type CommandHandler } from '../module.ts';

/** Human attaches a local git repository (spec: access). The hub prepared `path` as the repo's real top-level path. */
export const attachRepo: CommandHandler<{ projectId: ProjectId; path: string; mainBranch: string }> = (model, command, ctx) => {
  if (command.principal.kind !== 'human') return reject('forbidden', 'human only');
  const project = model.projects[command.input.projectId];
  if (!project) return reject('unknown_project', 'no such project');
  const author = authorOf(command.principal);
  const existing = Object.values(model.repos).find((r) => r.path === command.input.path);
  const repoId = (existing?.repoId ?? ctx.ids.next('repo')) as RepoId;
  const events = [];
  if (!existing) events.push(makeEvent(ctx, author, SYSTEM, 'repo.registered', { repoId, path: command.input.path, mainBranch: command.input.mainBranch }));
  else if (existing.mainBranch !== command.input.mainBranch) {
    return reject('main_mismatch', `this repository is already registered with main branch "${existing.mainBranch}"`);
  }
  events.push(makeEvent(ctx, author, inProject(project.projectId), 'project.repo_attached', { projectId: project.projectId, repoId }));
  return accept(events, { repoId });
};
