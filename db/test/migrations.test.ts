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
});