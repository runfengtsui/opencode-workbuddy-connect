// Tool-calling smoke test: forces a tool call and a full tool round-trip.
// Run: node test/tools.mjs [modelId] [intl|cn]
//      (region also reads $WORKBUDDY_REGION; defaults to intl)
import { WorkBuddyLanguageModel } from "../dist/language-model.js";
import { describeRegion, regionOptions } from "./region.mjs";

const MODEL = process.argv[2] || "hy3";
const REGION = regionOptions(process.argv[3]);
const lm = new WorkBuddyLanguageModel(MODEL, REGION);

console.log(`access point: ${describeRegion(REGION)}`);

const tools = [
  {
    type: "function",
    name: "get_weather",
    description: "Get current weather for a city",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string", description: "City name" } },
      required: ["city"],
    },
  },
];

const prompt = [
  { role: "system", content: "You are a helpful assistant with tools." },
  {
    role: "user",
    content: [
      {
        type: "text",
        text: "Call the get_weather tool for Shanghai. Do not answer without calling the tool.",
      },
    ],
  },
];

const options = {
  prompt,
  maxOutputTokens: 512,
  tools,
  messagesFormat: "messages",
  abortSignal: new AbortController().signal,
  providerOptions: {},
};

// Turn 1: expect a tool call back.
const t1 = await lm.doStream(options);
let toolCalls = [],
  text = "",
  finish = null;
for await (const p of t1.stream) {
  if (p.type === "text-delta") text += p.delta;
  else if (p.type === "tool-call") toolCalls.push(p);
  else if (p.type === "finish") finish = p.finishReason;
  else if (p.type === "error") throw p.error;
}
console.log(
  `turn1 finish=${JSON.stringify(finish)} text="${text.trim()}" toolCalls=${toolCalls.length}`,
);
for (const tc of toolCalls) console.log(`  call: ${tc.toolName} args=${tc.input}`);
if (finish?.unified !== "tool-calls" || toolCalls.length === 0) {
  console.log("FAIL turn1");
  process.exit(1);
}

// Turn 2: replay with the tool result, expect a final answer.
const tc = toolCalls[0];
const t2 = await lm.doStream({
  ...options,
  prompt: [
    ...prompt,
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: tc.toolCallId, toolName: tc.toolName, input: tc.input },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          output: { type: "text", value: "22C, sunny, light wind" },
        },
      ],
    },
  ],
});
let final = "";
finish = null;
for await (const p of t2.stream) {
  if (p.type === "text-delta") final += p.delta;
  else if (p.type === "finish") finish = p.finishReason;
  else if (p.type === "error") throw p.error;
}
console.log(`turn2 finish=${JSON.stringify(finish)} text="${final.trim()}"`);
if (finish?.unified !== "stop" || !/22|sunny|°C|C/i.test(final)) {
  console.log("FAIL turn2");
  process.exit(1);
}
console.log("PASS");
