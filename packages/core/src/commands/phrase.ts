import type { Random } from '../ports.ts';

const ADJECTIVES = [
  'amber', 'brave', 'calm', 'dusty', 'eager', 'fancy', 'gentle', 'hazel', 'icy', 'jolly', 'keen', 'lucky',
  'mellow', 'nimble', 'olive', 'proud', 'quiet', 'rapid', 'silver', 'tidy', 'upbeat', 'vivid', 'witty', 'young',
];
const ANIMALS = [
  'falcon', 'badger', 'otter', 'heron', 'lynx', 'panda', 'raven', 'tiger', 'walrus', 'yak', 'zebra', 'koala',
  'moose', 'newt', 'orca', 'puffin', 'quail', 'robin', 'seal', 'toucan', 'viper', 'wombat', 'bison', 'crane',
];

/** Short phrase the agent shows in its chat and the human matches in the app, e.g. `amber-falcon-42`. */
export function matchPhrase(random: Random): string {
  const adjective = ADJECTIVES[random.int(ADJECTIVES.length)];
  const animal = ANIMALS[random.int(ANIMALS.length)];
  return `${adjective}-${animal}-${10 + random.int(90)}`;
}
