// Enforces the dependency rule from docs/architecture/README.md §11, and keeps core pure (invariant 7).
//   protocol ← core ← hub ← cli;  protocol ← agent ← cli;  protocol ← app;  testkit may import anything.
// Run: node scripts/check-deps.ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

const ALLOWED: Record<string, readonly string[]> = {
  protocol: [],
  core: ['protocol'],
  hub: ['protocol', 'core'],
  agent: ['protocol'],
  cli: ['protocol', 'core', 'hub', 'agent'],
  app: ['protocol'],
  testkit: ['protocol', 'core', 'hub', 'agent'],
};

// Bare imports allowed in core besides workspace packages: schema library only, no IO.
const CORE_EXTERNAL = new Set(['zod']);
// Files in protocol that are Node-only; everything else must stay browser-safe.
const PROTOCOL_NODE_ONLY = new Set(['src/ws.ts', 'src/crypto.ts']);
const NODE_SUBPATHS = new Set(['@round-table/protocol/ws', '@round-table/protocol/crypto']);
// Packages that run on Node and may use the Node-only protocol subpaths.
const NODE_USERS = new Set(['hub', 'agent', 'cli', 'testkit']);

const IMPORT = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const problems: string[] = [];

for (const pkg of Object.keys(ALLOWED)) {
  const dir = join(ROOT, 'packages', pkg);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  for (const dep of declared.filter((d) => d.startsWith('@round-table/'))) {
    const target = dep.slice('@round-table/'.length);
    if (!ALLOWED[pkg]!.includes(target)) problems.push(`packages/${pkg}/package.json depends on ${dep}`);
  }

  for (const file of files(join(dir, 'src'))) {
    const rel = relative(dir, file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? match[3]!;
      const where = `packages/${pkg}/${rel}`;
      if (spec.startsWith('@round-table/')) {
        const target = spec.slice('@round-table/'.length).split('/')[0]!;
        if (!ALLOWED[pkg]!.includes(target)) problems.push(`${where} imports ${spec}`);
        if (NODE_SUBPATHS.has(spec) && !NODE_USERS.has(pkg)) problems.push(`${where} imports Node-only ${spec}`);
      } else if (pkg === 'core' && !spec.startsWith('.') && !CORE_EXTERNAL.has(spec)) {
        problems.push(`${where} imports ${spec} (core must stay pure)`);
      } else if (pkg === 'protocol' && !PROTOCOL_NODE_ONLY.has(rel) && (spec.startsWith('node:') || spec === 'ws')) {
        problems.push(`${where} imports ${spec} (protocol must stay browser-safe outside its Node-only subpaths)`);
      }
    }
    if (pkg === 'core' && /\bDate\.now\s*\(|\bnew Date\s*\(\s*\)|\bMath\.random\s*\(/.test(text)) {
      problems.push(`packages/core/${rel} reads the clock or randomness; take them from ctx`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Dependency rule violations:\n  ${problems.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log('Dependency rule: ok');
}
