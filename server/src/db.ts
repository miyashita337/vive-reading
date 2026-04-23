import { Database } from "bun:sqlite";
import { join } from "path";

const DB_PATH = join(import.meta.dir, "../../data/messages.db");

let db: Database;

export function getDb(): Database {
  if (!db) {
    const { mkdirSync } = require("fs");
    mkdirSync(join(import.meta.dir, "../../data"), { recursive: true });

    db = new Database(DB_PATH, { create: true });
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA foreign_keys=ON");

    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT '',
        author TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        filtered_text TEXT,
        tts_status TEXT NOT NULL DEFAULT 'pending',
        created_at DATETIME NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at)
    `);
  }
  return db;
}

export interface Message {
  id: number;
  source: string;
  channel: string;
  author: string;
  content: string;
  filtered_text: string | null;
  tts_status: string;
  created_at: string;
}

export function insertMessage(
  source: string,
  channel: string,
  author: string,
  content: string
): Message {
  const db = getDb();
  const stmt = db.prepare(
    "INSERT INTO messages (source, channel, author, content) VALUES (?, ?, ?, ?) RETURNING *"
  );
  return stmt.get(source, channel, author, content) as Message;
}

export function getMessages(fromId?: number, limit = 50): Message[] {
  const db = getDb();
  if (fromId) {
    return db
      .prepare("SELECT * FROM messages WHERE id >= ? ORDER BY id ASC LIMIT ?")
      .all(fromId, limit) as Message[];
  }
  return db
    .prepare("SELECT * FROM messages ORDER BY id DESC LIMIT ?")
    .all(limit) as Message[];
}

export function updateFilteredText(id: number, filteredText: string): void {
  const db = getDb();
  db.prepare(
    "UPDATE messages SET filtered_text = ?, tts_status = 'filtered' WHERE id = ?"
  ).run(filteredText, id);
}

export function updateTtsStatus(id: number, status: string): void {
  const db = getDb();
  db.prepare("UPDATE messages SET tts_status = ? WHERE id = ?").run(status, id);
}
