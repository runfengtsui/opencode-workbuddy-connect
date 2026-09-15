export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function logPlugin(message: string): void {
  try {
    // opencode captures stderr from the plugin host; keep the prefix so a
    // workbuddy line is greppable among every plugin's noise.
    process.stderr.write(`[workbuddy] ${message}\n`);
  } catch {
    /* logging must never break a request */
  }
}
