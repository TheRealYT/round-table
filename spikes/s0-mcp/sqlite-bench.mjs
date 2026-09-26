// S0: node:sqlite as the single writer. One transaction per command: append 3 events + 1 projection upsert.
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';
for (const sync of ['FULL', 'NORMAL']) {
  const file = `/tmp/rt-bench-${sync}.db`;
  for (const f of [file, file + '-wal', file + '-shm']) rmSync(f, { force: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=${sync};
    CREATE TABLE events(gpos INTEGER PRIMARY KEY, stream TEXT NOT NULL, sseq INTEGER NOT NULL, type TEXT, payload TEXT, UNIQUE(stream, sseq));
    CREATE TABLE proj(id TEXT PRIMARY KEY, n INTEGER);
    CREATE VIRTUAL TABLE search USING fts5(body);`);
  const ins = db.prepare('INSERT INTO events(stream, sseq, type, payload) VALUES (?, ?, ?, ?)');
  const up = db.prepare('INSERT INTO proj(id, n) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1');
  const fts = db.prepare('INSERT INTO search(body) VALUES (?)');
  const N = 3000; let seq = 0;
  const t0 = performance.now();
  for (let i = 0; i < N; i++) {
    db.exec('BEGIN IMMEDIATE');
    for (let k = 0; k < 3; k++) ins.run('project:p1', ++seq, 'message.sent', JSON.stringify({ body: `hello ${i}`, k }));
    up.run(`agent${i % 5}`);
    fts.run(`hello world message number ${i}`);
    db.exec('COMMIT');
  }
  const ms = performance.now() - t0;
  console.log(`synchronous=${sync}: ${N} commands in ${ms.toFixed(0)} ms = ${(N / ms * 1000).toFixed(0)} cmd/s, ${(ms / N).toFixed(3)} ms/cmd; journal=${db.prepare('PRAGMA journal_mode').get().journal_mode}`);
  db.close();
}
