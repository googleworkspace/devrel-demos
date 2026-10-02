import { getDb } from './index.js';

const dbPath = process.env.DATABASE_URL || './webhook-bridge.sqlite';
getDb(dbPath);
console.log(`✅ Drizzle SQLite schema pushed to ${dbPath} (using built-in node:sqlite)`);
