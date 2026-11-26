/**
 * Database connection and migration runner for SQLite via better-sqlite3
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export const DEFAULT_DB_PATH = path.join(__dirname, '..', 'simulator.db');
export const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

export function getDb(dbPath: string = DEFAULT_DB_PATH): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function runMigrations(db: Database.Database): string[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
  }
  return files;
}
