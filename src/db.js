// One small async interface over two databases, so the same business logic runs on
// SQLite (local `npm start`, tests) and Postgres (Netlify Database on the hosted site).
//   db.get(sql, ...params) -> first row | undefined
//   db.all(sql, ...params) -> rows
//   db.run(sql, ...params) -> { lastInsertRowid }
//   db.exec(sql), db.begin(), db.commit(), db.rollback()
// SQL is written in SQLite style with `?` placeholders; the Postgres adapter translates the few differences.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

export function sqliteDb(file = ':memory:') {
  const raw = new DatabaseSync(file);
  raw.exec(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  return {
    dialect: 'sqlite', raw, depth: 0,
    get: async (s, ...p) => raw.prepare(s).get(...p),
    all: async (s, ...p) => raw.prepare(s).all(...p),
    run: async (s, ...p) => ({ lastInsertRowid: Number(raw.prepare(s).run(...p).lastInsertRowid) }),
    exec: async (s) => raw.exec(s),
    begin: async () => raw.exec('BEGIN IMMEDIATE'), commit: async () => raw.exec('COMMIT'), rollback: async () => raw.exec('ROLLBACK'),
  };
}

export const TIMEZONE = process.env.POS_TIMEZONE || 'Asia/Karachi';
const NOW_TEXT = `to_char(now() AT TIME ZONE '${TIMEZONE.replace(/'/g, '')}','YYYY-MM-DD HH24:MI:SS')`;
const NUMERIC_TYPES = new Set([20, 1700]); // int8 (COUNT/SUM) and numeric come back as strings from pg

export function translate(sql) {
  let s = sql.replace(/datetime\('now','localtime'\)/g, NOW_TEXT).replace(/\bLIKE\b/g, 'ILIKE');
  if (/INSERT OR IGNORE INTO/.test(s)) s = s.replace('INSERT OR IGNORE INTO', 'INSERT INTO') + ' ON CONFLICT DO NOTHING';
  let n = 0; s = s.replace(/\?/g, () => `$${++n}`);
  return s;
}

/** `client` is a connected pg / Neon pool client; all queries in one request share it (needed for transactions). */
export function pgDb(client) {
  const q = async (s, p) => {
    const r = await client.query(s, p);
    const conv = (r.fields || []).filter((f) => NUMERIC_TYPES.has(f.dataTypeID)).map((f) => f.name);
    if (conv.length) for (const row of r.rows) for (const k of conv) if (row[k] != null) row[k] = Number(row[k]);
    return r.rows;
  };
  return {
    dialect: 'pg', depth: 0,
    get: async (s, ...p) => (await q(translate(s), p))[0],
    all: async (s, ...p) => q(translate(s), p),
    run: async (s, ...p) => { let t = translate(s); if (/^\s*INSERT/i.test(t) && !/RETURNING/i.test(t)) t += ' RETURNING *';
      const rows = await q(t, p); return { lastInsertRowid: rows[0]?.id != null ? Number(rows[0].id) : undefined }; },
    exec: async (s) => { await client.query(s); },
    begin: async () => { await client.query('BEGIN'); }, commit: async () => { await client.query('COMMIT'); }, rollback: async () => { await client.query('ROLLBACK'); },
  };
}
