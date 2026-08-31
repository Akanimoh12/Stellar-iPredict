import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '..', 'migrations');

describe('migration prefix uniqueness', () => {
  it('no two up-migration files share a numeric prefix', () => {
    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql') && !f.endsWith('.down.sql'));

    // Extract numeric prefixes
    const prefixes = files
      .map(f => {
        const match = f.match(/^(\d+)_/);
        if (!match) {
          throw new Error(`File "${f}" does not start with a numeric prefix (e.g. NNNN_name.sql)`);
        }
        return match[1];
      });

    const seen: Record<string, string[]> = {};
    for (let i = 0; i < files.length; i++) {
      const prefix = prefixes[i];
      if (!seen[prefix]) {
        seen[prefix] = [];
      }
      seen[prefix].push(files[i]);
    }

    const duplicates = Object.entries(seen)
      .filter(([, fileList]) => fileList.length > 1)
      .map(([prefix, fileList]) => `Prefix ${prefix}: ${fileList.join(', ')}`);

    if (duplicates.length > 0) {
      throw new Error(
        'Duplicate migration prefix(es) found:\n' +
        duplicates.map(d => `  ${d}`).join('\n') +
        '\n\nEach migration must have a unique numeric prefix. ' +
        'Renumber the colliding file(s) to an unused number.'
      );
    }
  });

  it('exports MIGRATION_ADVISORY_LOCK_KEY constant for concurrent locking', async () => {
    const { MIGRATION_ADVISORY_LOCK_KEY } = await import('../migrate.js');
    expect(MIGRATION_ADVISORY_LOCK_KEY).toBe('8574639201');
  });

  it('migration 0011 uses guarded DO block for oracle_submission_status ENUM creation', () => {
    const sqlPath = path.join(MIGRATIONS_DIR, '0011_extend_oracle_submissions.sql');
    expect(fs.existsSync(sqlPath)).toBe(true);
    const sql = fs.readFileSync(sqlPath, 'utf8');

    expect(sql).not.toContain('CREATE TYPE IF NOT EXISTS');
    expect(sql).toContain('DO $$');
    expect(sql).toContain('CREATE TYPE oracle_submission_status AS ENUM');
    expect(sql).toContain('WHEN duplicate_object THEN NULL;');
  });

  it('adds an events archive table and retention procedure for hot-table cleanup', () => {
    const sqlPath = path.join(MIGRATIONS_DIR, '0013_events_archival.sql');
    expect(fs.existsSync(sqlPath)).toBe(true);

    const sql = fs.readFileSync(sqlPath, 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS events_archive');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION archive_old_events');
    expect(sql).toContain('retention_days');
    expect(sql).toContain('events_archive');
  });

  it('0018 defines a retention policy registry and an operational enforcement function', () => {
    const sqlPath = path.join(MIGRATIONS_DIR, '0018_data_retention.sql');
    expect(fs.existsSync(sqlPath)).toBe(true);

    const sql = fs.readFileSync(sqlPath, 'utf8');
    // Machine-readable policy, one row per category, with a justification.
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS data_retention_policies');
    expect(sql).toContain("class IN ('operational', 'audit')");
    expect(sql).toContain('justification');
    // Operational purge functions, all batched.
    expect(sql).toContain('CREATE OR REPLACE FUNCTION purge_dead_letter_events');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION purge_events_archive');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION purge_idempotency_keys');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION purge_stale_oracle_submissions');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION enforce_data_retention');
    // Purge of stale submissions must only touch rejected ones, never finalized.
    expect(sql).toContain("s.status = 'rejected'");
    // Repairs the non-functional 0013 archive_old_events (RETURNING with no INTO).
    expect(sql).toContain('CREATE OR REPLACE FUNCTION archive_old_events');
    expect(sql).toContain('SELECT count(*) INTO moved_count FROM deleted');
    // Down migration exists.
    expect(fs.existsSync(path.join(MIGRATIONS_DIR, '0018_data_retention.down.sql'))).toBe(true);
  });

  it('0019 drops the finalized_at default and backfills non-finalized rows to NULL (#409)', () => {
    const sqlPath = path.join(MIGRATIONS_DIR, '0019_oracle_finalized_at_nullable.sql');
    expect(fs.existsSync(sqlPath)).toBe(true);

    const sql = fs.readFileSync(sqlPath, 'utf8');
    expect(sql).toContain('ALTER TABLE oracle_submissions ALTER COLUMN finalized_at DROP DEFAULT');
    expect(sql).toContain('SET finalized_at = NULL');
    expect(sql).toContain("WHERE status <> 'finalized'");
    expect(fs.existsSync(path.join(MIGRATIONS_DIR, '0019_oracle_finalized_at_nullable.down.sql'))).toBe(true);
  });

  it('0020 unifies oracle address columns on CHAR(56) with a shape CHECK and canonicalizes oracle_disputes.outcome (#408)', () => {
    const sqlPath = path.join(MIGRATIONS_DIR, '0020_oracle_address_types.sql');
    expect(fs.existsSync(sqlPath)).toBe(true);

    const sql = fs.readFileSync(sqlPath, 'utf8');
    // Reports (never silently drops) violating rows before altering.
    expect(sql).toContain('RAISE EXCEPTION');
    // Column types tightened to match council_votes.member.
    expect(sql).toContain('ALTER TABLE oracle_submissions ALTER COLUMN submitter TYPE CHAR(56)');
    expect(sql).toContain('ALTER TABLE oracle_disputes ALTER COLUMN submitter TYPE CHAR(56)');
    expect(sql).toContain('ALTER TABLE oracle_disputes ALTER COLUMN challenger TYPE CHAR(56)');
    // Shape CHECK matches backend/src/api/profile.ts's STELLAR_ADDRESS_REGEX.
    expect(sql).toContain("CHECK (submitter ~ '^G[A-Z2-7]{55}$')");
    expect(sql).toContain("CHECK (challenger ~ '^G[A-Z2-7]{55}$')");
    // outcome column reviewed and documented for both tables.
    expect(sql).toContain("ADD CONSTRAINT ck_oracle_disputes_outcome_canonical");
    expect(sql).toContain("CHECK (outcome IN ('YES', 'NO'))");
    expect(sql).toContain('COMMENT ON COLUMN oracle_submissions.outcome');
    expect(sql).toContain('COMMENT ON COLUMN oracle_disputes.outcome');
    expect(fs.existsSync(path.join(MIGRATIONS_DIR, '0020_oracle_address_types.down.sql'))).toBe(true);
  });

  it('0021 widens market_id to BIGINT, deletes orphans, and adds FKs to markets(id) ON DELETE RESTRICT (#407)', () => {
    const sqlPath = path.join(MIGRATIONS_DIR, '0021_oracle_market_fk.sql');
    expect(fs.existsSync(sqlPath)).toBe(true);

    const sql = fs.readFileSync(sqlPath, 'utf8');
    // Type widened to match markets.id / council_votes.market_id before the FK.
    expect(sql).toContain('ALTER TABLE oracle_submissions ALTER COLUMN market_id TYPE BIGINT');
    expect(sql).toContain('ALTER TABLE oracle_disputes ALTER COLUMN market_id TYPE BIGINT');
    // Orphans are reported (RAISE NOTICE with a sample), not silently dropped.
    expect(sql).toContain('RAISE NOTICE');
    expect(sql).toMatch(/DELETE FROM oracle_submissions/);
    expect(sql).toMatch(/DELETE FROM oracle_disputes/);
    expect(sql).toMatch(/DELETE FROM council_votes/);
    // Foreign keys on all three oracle tables, ON DELETE RESTRICT, with the
    // choice explained in a SQL comment.
    expect(sql).toContain('ADD CONSTRAINT fk_oracle_submissions_market_id');
    expect(sql).toContain('ADD CONSTRAINT fk_oracle_disputes_market_id');
    expect(sql).toContain('ADD CONSTRAINT fk_council_votes_market_id');
    expect(sql).toContain('REFERENCES markets(id) ON DELETE RESTRICT');
    expect(sql.toUpperCase()).toContain('-- ON DELETE RESTRICT FOR ALL THREE');
    expect(fs.existsSync(path.join(MIGRATIONS_DIR, '0021_oracle_market_fk.down.sql'))).toBe(true);
  });
});