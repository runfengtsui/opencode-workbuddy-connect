// Offline SSE framing regression test (no network).
//
// The WorkBuddy gateway stamps EVERY delta with `tool_calls: []`, and `[]` is
// truthy. An earlier build treated that as "a tool call is arriving", closed
// the open text/reasoning block on every token, and opencode rendered one
// token per line. Feed the parser the gateway's real chunk shape and assert
// contiguous blocks.
// Run: node test/stream.mjs
process.env.WORKBUDDY_TOKEN = "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJ1aWQiOiJ0ZXN0LXVpZCJ9.sig";
delete process.env.WORKBUDDY_BASE_URL;

const { WorkBuddyLanguageModel } = await import("../dist/language-model.js");

function sseResponse(frames) {
  const enc = new TextEncoder();
  const lines = frames.map((f) => enc.encode(`data: ${JSON.stringify(f)}\n\n`));
  lines.push(enc.encode("data: [DONE]\n\n"));
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: new ReadableStream({
      pull(c) {
        if (i < lines.length) c.enqueue(lines[i++]);
        else c.close();
      },
    }),
  };
}

// Exactly the shape captured from the live gateway.
const stamp = { function_call: null, refusal: "", tool_calls: [], extra_fields: null };
function chunk(patch) {
  return { role: undefined, content: "", reasoning_content: "", ...stamp, ...patch };
}
/** Wrap a delta into an SSE frame; `finish` rides the frame's choice. */
function frame(delta, finish) {
  return { choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] };
}

async function collect(frames, model = "hy3") {
  const original = globalThis.fetch;
  globalThis.fetch = async () => sseResponse(frames);
  try {
    const r = await new WorkBuddyLanguageModel(model, {}).doStream({
      prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      abortSignal: new AbortController().signal,
      messagesFormat: "messages",
      providerOptions: {},
    });
    const parts = [];
    for await (const p of r.stream) parts.push(p);
    return parts;
  } finally {
    globalThis.fetch = original;
  }
}

let fail = 0;
const check = (cond, msg) => {
  if (!cond) {
    console.log(`FAIL: ${msg}`);
    fail++;
  }
};

const types = (parts) =>
  parts
    .filter(
      (p) =>
        p.type === "text-start" ||
        p.type === "text-end" ||
        p.type === "reasoning-start" ||
        p.type === "reasoning-end",
    )
    .map((p) => p.type);

// 1. Plain answer, reasoning then text, empty tool_calls on every delta.
{
  const frames = [
    frame(chunk({ role: "assistant" })),
    ...["The ", "user ", "asks "].map((t) => frame(chunk({ reasoning_content: t }))),
    ...["4", " is", " the", " answer"].map((t) => frame(chunk({ content: t }))),
    frame(chunk({}), "stop"),
  ];
  const parts = await collect(frames);
  const text = parts
    .filter((p) => p.type === "text-delta")
    .map((p) => p.delta)
    .join("");
  const reasoning = parts
    .filter((p) => p.type === "reasoning-delta")
    .map((p) => p.delta)
    .join("");
  console.log(`text=${JSON.stringify(text)} reasoning=${JSON.stringify(reasoning)}`);
  console.log(`blocks: ${types(parts).join(",")}`);
  check(text === "4 is the answer", "text deltas lost or reordered");
  check(reasoning === "The user asks ", "reasoning deltas lost");
  check(
    types(parts).join() === "reasoning-start,reasoning-end,text-start,text-end",
    "must be exactly 1 reasoning + 1 text block",
  );
  check(
    parts.at(-1).type === "finish" && parts.at(-1).finishReason.unified === "stop",
    "finish reason",
  );
}

// 2. Interleaved reasoning/text stays one block per contiguous run.
{
  const parts = await collect([
    frame(chunk({ reasoning_content: "thin" })),
    frame(chunk({ content: "a" })),
    frame(chunk({ reasoning_content: "k" })),
    frame(chunk({ content: "b" })),
  ]);
  console.log(`interleaved blocks: ${types(parts).join(",")}`);
  check(
    types(parts).filter((t) => t === "text-start").length === 2,
    "two text runs -> two text-start",
  );
  check(
    parts
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta)
      .join("") === "ab",
    "text preserved",
  );
}

// 3. A real tool call still closes text and emits the call.
{
  const parts = await collect([
    frame(chunk({ content: "sure" })),
    frame(
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"ci' },
          },
        ],
      }),
    ),
    frame(chunk({ tool_calls: [{ index: 0, function: { arguments: 'ty":"sh"}' } }] })),
    frame(chunk({}), "tool_calls"),
  ]);
  const call = parts.find((p) => p.type === "tool-call");
  console.log(`tool-call: ${call ? `${call.toolName} ${call.input}` : "(none)"}`);
  check(!!call && call.toolName === "get_weather", "tool call not emitted");
  check(call?.input === '{"city":"sh"}', "arguments not aggregated");
  check(parts.at(-1).finishReason.unified === "tool-calls", "finish reason should be tool-calls");
  check(
    parts.some((p) => p.type === "text-end"),
    "text block must close before the call",
  );
}

if (fail) {
  console.log(`FAIL x${fail}`);
  process.exit(1);
}
console.log("PASS");
