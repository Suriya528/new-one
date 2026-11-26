/**
 * Executes the showcase SQL query in docs/query.sql and prints formatted results.
 */
import fs from 'fs';
import path from 'path';
import { getDb } from './database';

const QUERY_PATH = path.resolve(__dirname, '..', '..', 'docs', 'query.sql');

function main() {
  if (!fs.existsSync(QUERY_PATH)) {
    console.error(`Query file not found: ${QUERY_PATH}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(QUERY_PATH, 'utf-8');
  const db = getDb();
  const rows = db.prepare(sql).all();
  db.close();

  console.log(`\nShowcase SQL Query Output (${rows.length} rows) from ${QUERY_PATH}:\n`);
  console.table(rows);
}

main();
