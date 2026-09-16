// Live end-to-end smoke test for the compiled plugin.
// Run: node test/live.mjs [modelId] [intl|cn]
//      (region also reads $WORKBUDDY_REGION; defaults to intl)
import { resolveWorkBuddyCredentials } from "../dist/auth.js";
import { WorkBuddyLanguageModel } from "../dist/language-model.js";
import { modelTable } from "../dist/models.js";
import { describeRegion, regionOptions } from "./region.mjs";

const REGION = regionOptions(process.argv[3]);
const MODEL = process.argv[2] || "hy3";
const TABLE = modelTable(REGION.providerID === "workbuddy-cn" ? "cn" : "intl");

// 1. Model table check: the region's own catalogue, 1M models at 1M.
console.log("== model table (region's own entries) ==");
for (const m of TABLE) {
  console.log(
    `${m.id.padEnd(22)} ctx=${String(m.contextWindow).padStart(9)} out=${String(m.maxTokens).padStart(7)} reasoning=${m.reasoning} credits=${m.credits ?? "-"} efforts=${(m.efforts ?? []).join(",") || "-"}`,
  );
}
console.log(
  "1M models:",
  TABLE.filter((m) => m.contextWindow >= 1_000_000)
    .map((m) => m.id)
    .join(", "),
);

// 2. Credential chain check (options -> region env -> own store -> desktop file).
console.log("\n== credentials ==");
console.log(`region: ${describeRegion(REGION)}`);
const cred = await resolveWorkBuddyCredentials(REGION);
console.log(
  `uid=${cred.uid} domain=${cred.domain} token=${cred.accessToken.slice(0, 8)}... exp=${cred.expiresAtMs ? new Date(cred.expiresAtMs).toISOString() : "-"}`,
);

// 3. Live stream through the real LanguageModelV3 implementation.
console.log(`\n== live stream (${REGION.providerID}/${MODEL}) ==`);
const lm = new WorkBuddyLanguageModel(MODEL, REGION);
const { stream } = await lm.doStream({
  prompt: [
    { role: "system", content: "You are terse. Answer in one short sentence." },
    {
      role: "user",
      content: [{ type: "text", text: "What is 17*23? Reply with just the number." }],
    },
  ],
  maxOutputTokens: 256,
  messagesFormat: "messages",
  tools: [],
  abortSignal: new AbortController().signal,
  providerOptions: {},
});

let text = "";
let reasoning = "";
let usage = null;
let finish = null;
for await (const part of stream) {
  if (part.type === "text-delta") text += part.delta;
  else if (part.type === "reasoning-delta") reasoning += part.delta;
  else if (part.type === "finish") {
    usage = part.usage;
    finish = part.finishReason;
  } else if (part.type === "error") throw part.error;
}
console.log(
  `reasoning(${reasoning.length}ch) | text: ${text.trim()} | finish=${JSON.stringify(finish)}`,
);
if (usage)
  console.log(
    `usage: input=${usage.inputTokens.total} output=${usage.outputTokens.total} reasoning=${usage.outputTokens.reasoning ?? "-"}`,
  );
else {
  console.log("FAIL: no usage received");
  process.exitCode = 1;
}
if (!text.includes("391")) {
  console.log("FAIL: unexpected answer");
  process.exitCode = 1;
} else console.log("PASS");
