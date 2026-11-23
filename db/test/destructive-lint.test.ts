import { describe, expect, it } from 'vitest';
import { lintMigrationSql } from '../migrate.js';

describe('lintMigrationSql (Issue #1021)', () => {
  it('allows safe migrations without destructive statements', () => {
    expect(() => {
      lintMigrationSql('0032_safe_migration.sql', 'CREATE TABLE foo (id INT); ALTER TABLE foo ADD COLUMN name TEXT;');
    }).not.toThrow();
  });

  it('rejects DROP TABLE without review marker in up migration', () => {
    expect(() => {
      lintMigrationSql('0033_drop_migration.sql', 'DROP TABLE legacy_users;');
    }).toThrow(/Destructive statement found in up migration.*without explicit review marker/);
  });

  it('rejects TRUNCATE without review marker in up migration', () => {
    expect(() => {
      lintMigrationSql('0034_truncate_migration.sql', 'TRUNCATE events;');
    }).toThrow(/Destructive statement found in up migration.*without explicit review marker/);
  });

  it('accepts DROP TABLE with explicit review marker "-- ack:destructive"', () => {
    expect(() => {
      lintMigrationSql(
        '0035_intentional_drop.sql',
        `-- ack:destructive\nDROP TABLE temporary_cache;`
      );
    }).not.toThrow();
  });

  it('accepts TRUNCATE with explicit review marker "-- ack:destructive"', () => {
    expect(() => {
      lintMigrationSql(
        '0036_intentional_truncate.sql',
        `-- ack:destructive\nTRUNCATE scratch_space;`
      );
    }).not.toThrow();
  });

  it('ignores down migrations even if they contain DROP TABLE or TRUNCATE', () => {
    expect(() => {
      lintMigrationSql('0037_rollback.down.sql', 'DROP TABLE foo; TRUNCATE bar;');
    }).not.toThrow();
  });
});
