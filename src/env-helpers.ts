import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function readEnvSafe(name: string): string {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

export const DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function envBool(name: string): boolean {
  const value = readEnvSafe(name).toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** A file under opencode's own cache dir -- the same place its models.dev
 * cache lives, so provider caches are found (and cleared) together. */
export function opencodeCacheFile(filename: string): string {
  const base = readEnvSafe("XDG_CACHE_HOME") || join(homedir(), ".cache");
  return join(base, "opencode", filename);
}

/**
 * Write JSON so a reader never sees a half-written file. A credential store or
 * model cache truncated by a crash is indistinguishable from "no login"
 * downstream -- which is exactly the "auth keeps disappearing" failure mode --
 * so every write here goes through a temp file + rename (atomic on the same
 * filesystem).
 */
export function writeJsonAtomic(file: string, payload: unknown, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload), { mode });
  renameSync(tmp, file);
}
