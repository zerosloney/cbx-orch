import { createReadStream } from "node:fs";
import path from "node:path";
import { database, now } from "./storage.js";
import { atomicWriteFile, isMissing } from "./file-utils.js";

/** 原子自增并返回下一个事件 seq。用 SQLite 单事务保证跨进程唯一：INSERT OR IGNORE 初始化后 UPDATE ... RETURNING 取新值。
 *  并发进程在 SQLite 行锁下串行化，不会读到相同 seq。 */
export async function nextEventSeq(workspace: string): Promise<number> {
  const db = await database(workspace);
  return db.transaction(() => {
    db.prepare("INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)").run(
      "event_seq",
      "0",
    );
    const row = db
      .prepare(
        "UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = ? RETURNING CAST(value AS INTEGER) AS seq",
      )
      .get("event_seq") as { seq: number } | undefined;
    if (!row) throw new Error("event_seq 分配失败：metadata 表可能已损坏。");
    return Number(row.seq);
  })();
}

async function pruneDeliveryFailureArtifact(
  workspace: string,
  cutoff: number,
): Promise<number> {
  const file = path.join(workspace, ".cbx", "delivery-failures.ndjson");
  const retained: string[] = [];
  let removed = 0;
  try {
    const readline = await import("node:readline");
    const stream = createReadStream(file, { encoding: "utf8" });
    try {
      const reader = readline.createInterface({
        input: stream,
        crlfDelay: Infinity,
      });
      for await (const line of reader) {
        if (!line) continue;
        try {
          const record = JSON.parse(line) as { at?: string; createdAt?: string };
          const at = Date.parse(record.at ?? record.createdAt ?? "");
          if (Number.isFinite(at) && at < cutoff) {
            removed += 1;
            continue;
          }
        } catch {
          /* preserve malformed records for manual recovery */
        }
        retained.push(line);
      }
    } finally {
      try {
        stream.close();
      } catch {
        /* best effort */
      }
    }
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
  if (removed)
    await atomicWriteFile(
      file,
      retained.length ? retained.join("\n") + "\n" : "",
    );
  return removed;
}

export async function prunePersistedData(
  workspace: string,
  retentionDays?: number,
): Promise<number> {
  if (!retentionDays) return 0;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const db = await database(workspace);
  const sqlite = db
    .prepare("DELETE FROM delivery_failures WHERE created_at < ?")
    .run(new Date(cutoff).toISOString()).changes;
  return sqlite + (await pruneDeliveryFailureArtifact(workspace, cutoff));
}
