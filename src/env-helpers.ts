export function readEnvSafe(name: string): string {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : "";
}

export const DEFAULT_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
