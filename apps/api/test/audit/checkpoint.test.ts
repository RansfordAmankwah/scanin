import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FileCheckpointSink,
  MemoryCheckpointSink,
  verifyCheckpoints,
  writeCheckpoint,
} from '../../src/audit/checkpoint.js';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAudit } from '../../src/audit.js';
import { createMigratedTestDatabase, type MigratedTestDatabase } from '../helpers/testDb.js';

let db: MigratedTestDatabase;

beforeAll(async () => {
  db = await createMigratedTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

let seq = 0;
async function addEvents(count: number, opts: { retainDays?: number } = {}) {
  for (let i = 0; i < count; i++) {
    seq += 1;
    await writeAudit(db.appPool, {
      class: 'SECURITY',
      actorType: 'ANONYMOUS',
      action: `EVENT_${seq}`,
      requestId: `req-${seq}`,
      summary: { n: seq },
      retainUntil: null,
    });
    if (opts.retainDays !== undefined) {
      await db.pool.query(
        `UPDATE audit_events SET retain_until = current_date + $1::int WHERE action = $2`,
        [opts.retainDays, `EVENT_${seq}`],
      );
    }
  }
}
// The tests write and read checkpoints immediately, so no "settling" margin is needed.
const checkpoint = (sink: MemoryCheckpointSink) => writeCheckpoint(db.appPool, sink, 0);
const verify = (sink: MemoryCheckpointSink) => verifyCheckpoints(db.appPool, sink);
const idOf = async (action: string): Promise<number> =>
  Number(
    (await db.pool.query<{ id: string }>('SELECT id FROM audit_events WHERE action = $1', [action]))
      .rows[0]!.id,
  );

describe('AUD-03 audit checkpoints make tampering detectable', () => {
  it('accepts an untouched audit log, and writes only new rows on each run', async () => {
    const sink = new MemoryCheckpointSink();
    await addEvents(5);
    const first = await checkpoint(sink);
    expect(first.written).toBe(true);
    expect(first.entries).toBeGreaterThanOrEqual(5);
    expect(await verify(sink)).toMatchObject({ ok: true, problems: [] });

    expect(await checkpoint(sink)).toEqual({ written: false, entries: 0 }); // nothing new
    await addEvents(3);
    const second = await checkpoint(sink);
    expect(second.entries).toBe(3);
    expect(sink.files.size).toBe(2);
    const result = await verify(sink);
    expect(result.ok).toBe(true);
    expect(result.checkedRows).toBe(first.entries + 3);
  });

  it('detects a modified past event', async () => {
    const sink = new MemoryCheckpointSink();
    await addEvents(3);
    await checkpoint(sink);
    const target = await idOf(`EVENT_${seq - 1}`);
    await db.pool.query(`UPDATE audit_events SET outcome = 'DENIED' WHERE id = $1`, [target]); // owner rewrites history
    const result = await verify(sink);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([{ kind: 'MODIFIED', id: target }]);
    await db.pool.query(`UPDATE audit_events SET outcome = 'SUCCESS' WHERE id = $1`, [target]); // put it back
    expect((await verify(sink)).ok).toBe(true);
  });

  it('detects every kind of change to a row, not just one column', async () => {
    const sink = new MemoryCheckpointSink();
    await addEvents(1);
    await checkpoint(sink);
    const id = await idOf(`EVENT_${seq}`);
    const changes = [
      `action = 'EDITED'`,
      `actor_type = 'OPERATOR'`,
      `summary = '{"n": -1}'`,
      `request_id = 'forged'`,
      `entity_id = 'x'`,
      `occurred_at = occurred_at + interval '1 second'`,
      `retain_until = retain_until + 1`,
      `ip_hash = '\\x00'`,
    ];
    for (const change of changes) {
      // Make the change in a transaction, verify through the same connection, then roll it back,
      // so the row returns to exactly what it was (including microsecond timestamps).
      const c = await db.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`UPDATE audit_events SET ${change} WHERE id = $1`, [id]);
        expect((await verifyCheckpoints(c, sink)).problems, change).toContainEqual({
          kind: 'MODIFIED',
          id,
        });
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }
    expect((await verify(sink)).ok).toBe(true);
  });

  it('detects a deleted event that should still be retained, but accepts a legitimate purge', async () => {
    const sink = new MemoryCheckpointSink();
    await addEvents(2, { retainDays: 30 }); // still within retention
    await addEvents(2, { retainDays: -1 }); // already past retention
    await checkpoint(sink);
    const retained = await idOf(`EVENT_${seq - 3}`);
    const expired = await idOf(`EVENT_${seq - 1}`);

    await db.pool.query('DELETE FROM audit_events WHERE id = $1', [expired]); // what retention does
    expect((await verify(sink)).ok).toBe(true);

    await db.pool.query('DELETE FROM audit_events WHERE id = $1', [retained]); // an owner covering tracks
    expect((await verify(sink)).problems).toContainEqual({ kind: 'MISSING', id: retained });
  });

  it('detects a row slipped into a range that was already checkpointed', async () => {
    const sink = new MemoryCheckpointSink();
    await addEvents(3);
    const hole = await idOf(`EVENT_${seq - 1}`);
    await db.pool.query('DELETE FROM audit_events WHERE id = $1', [hole]); // a gap exists when the checkpoint is taken
    await checkpoint(sink);
    expect((await verify(sink)).ok).toBe(true);

    await db.pool.query(
      `INSERT INTO audit_events (id, class, actor_type, action, retain_until)
       OVERRIDING SYSTEM VALUE VALUES ($1, 'DOMAIN', 'SYSTEM', 'FORGED_LATER', current_date + 400)`,
      [hole],
    );
    expect((await verify(sink)).problems).toEqual([{ kind: 'EXTRA', id: hole }]);
    await db.pool.query('DELETE FROM audit_events WHERE id = $1', [hole]);
    expect((await verify(sink)).ok).toBe(true);
  });

  it('notices a missing checkpoint segment as a gap, and a corrupted one', async () => {
    const sink = new MemoryCheckpointSink();
    await addEvents(2);
    await checkpoint(sink);
    await addEvents(2);
    await checkpoint(sink);
    await addEvents(2);
    await checkpoint(sink);
    const names = await sink.list();
    expect(names).toHaveLength(3);
    expect((await verify(sink)).ok).toBe(true);

    const middle = names[1]!;
    const content = sink.files.get(middle)!;
    sink.files.delete(middle); // someone removes a segment
    expect((await verify(sink)).problems.some((p) => p.kind === 'GAP')).toBe(true);

    sink.files.set(middle, 'not json at all');
    expect((await verify(sink)).problems).toContainEqual({ kind: 'BAD_SEGMENT', name: middle });
    sink.files.set(middle, content);
    expect((await verify(sink)).ok).toBe(true);
  });

  it('never overwrites a checkpoint and keeps personal data out of them', async () => {
    const sink = new MemoryCheckpointSink();
    await addEvents(1);
    await checkpoint(sink);
    const name = (await sink.list())[0]!;
    await expect(sink.write(name, '{}')).rejects.toThrow();
    const text = sink.files.get(name)!;
    expect(text).not.toMatch(/EVENT_|req-|ANONYMOUS|summary/); // fingerprints and dates only
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed.entries[0]).sort()).toEqual(['h', 'id', 'ru']);
    expect(parsed.entries[0].h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('works against files on disk, refusing to overwrite them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'scanin-audit-'));
    try {
      const sink = new FileCheckpointSink(join(dir, 'cp'));
      await addEvents(2);
      const r = await writeCheckpoint(db.appPool, sink, 0);
      expect(r.written).toBe(true);
      const files = await readdir(join(dir, 'cp'));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^audit-\d{12}\.json$/);
      expect(JSON.parse(await readFile(join(dir, 'cp', files[0]!), 'utf8')).version).toBe(1);
      await expect(sink.write(files[0]!, 'x')).rejects.toThrow();
      expect((await verifyCheckpoints(db.appPool, sink)).ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves very recent rows for the next run so a slow transaction cannot cause a false alarm', async () => {
    const sink = new MemoryCheckpointSink();
    await addEvents(2);
    const result = await writeCheckpoint(db.appPool, sink, 2); // the default two-minute margin
    expect(result).toEqual({ written: false, entries: 0 }); // everything is too fresh to settle
    await db.pool.query(`UPDATE audit_events SET occurred_at = occurred_at - interval '1 hour'`);
    expect((await writeCheckpoint(db.appPool, sink, 2)).written).toBe(true);
    expect((await verify(sink)).ok).toBe(true);
  });
});
