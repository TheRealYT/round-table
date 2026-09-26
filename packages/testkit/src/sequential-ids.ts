import { ID_PREFIX, type IdKind } from '@round-table/protocol';
import type { IdGen } from '@round-table/core';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Deterministic, valid ULID-shaped ids for tests: prj_00000000000000000000000001, … */
export class SequentialIds implements IdGen {
  private counter = 0;

  next(kind: IdKind): string {
    this.counter += 1;
    let n = this.counter;
    let body = '';
    for (let i = 0; i < 26; i++) {
      body = CROCKFORD[n % 32] + body;
      n = Math.floor(n / 32);
    }
    return `${ID_PREFIX[kind]}_${body}`;
  }
}
