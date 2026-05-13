import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function readStateSchemaVersion(dbPath: string): number | null {
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    db.close();
  }
}
