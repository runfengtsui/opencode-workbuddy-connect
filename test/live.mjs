// Live end-to-end smoke test for the compiled plugin.
// Run: node test/live.mjs [modelId]   (from F:\code\opencode-workbuddy-connect)
import { WORKBUDDY_MODELS } from "../dist/models.js";
import { resolveWorkBuddyCredentials } from "../dist/auth.js";
import { WorkBuddyLanguageModel } from "../dist/language-model.js";

const MODEL = process.argv[2] || "hy3";

// 1. Model table check: 1M context models registered at 1M.
console.log("== model table (context window) ==");
for (const m of WORKBUDDY_MODELS) {
  console.log(`${m.id.padEnd(22)} ctx=${String(m.contextWindow).padStart(9)} out=${String(m.maxTokens).padStart(7)} reasoning=${m.reasoning} efforts=${(m.efforts ?? []).join(",") || "-"}`);
}
console.log("1M models:", WORKBUDDY_MODELS.filter((m) => m.contextWindow >= 1_000_000).map((m) => m.id).join(", "));

// 2. Credential chain check (options -> env -> own store -> desktop file).
console.log("\n== credentials ==");
const cred = await resolveWorkBuddyCredentials({});
console.log(`uid=${cred.uid} domain=${cred.domain} token=${cred.accessToken.slice(0, 8)}... exp=${cred.expiresAtMs ? new Date(cred.expiresAtMs).toISOString() : "-"}`);

// 3. Live stream through the real LanguageModelV3 implementation.
console.log(`\n== live stream (${MODEL}) ==`);
const lm = new WorkBuddyLanguageModel(MODEL, {});
const { stream } = await lm.doStream({
  prompt: [
    { role: "system", content: "You are terse. Answer in one short sentence." },
    { role: "user", content: [{ type: "text", text: "What is 17*23? Reply with just the number." }] },
  ],
  maxOutputTokens: 256,
  messagesFormat: "messages",
  tools: [],
  abortSignal: new AbortController().signal,
  providerOptions: {},
});

let text = "", reasoning = "", usage = null, finish = null;
for await (const part of stream) {
  if (part.type === "text-delta") text += part.delta;
  else if (part.type === "reasoning-delta") reasoning += part.delta;
  else if (part.type === "finish") { usage = part.usage; finish = part.finishReason; }
  else if (part.type === "error") throw part.error;
}
console.log(`reasoning(${reasoning.length}ch) | text: ${text.trim()} | finish=${JSON.stringify(finish)}`);
if (usage) console.log(`usage: input=${usage.inputTokens.total} output=${usage.outputTokens.total} reasoning=${usage.outputTokens.reasoning ?? "-"}`);
else { console.log("FAIL: no usage received"); process.exitCode = 1; }
if (!text.includes("391")) { console.log("FAIL: unexpected answer"); process.exitCode = 1; }
else console.log("PASS");
