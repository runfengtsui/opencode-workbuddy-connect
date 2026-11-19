// Offline logging-policy test (no network).
//
// Routine lifecycle lines used to go straight to stderr, so every opencode
// session was littered with `[workbuddy] registered 11 models` / `setup[v2]`
// chatter. The policy now is: warn+error always reach the terminal, everything
// at/above WORKBUDDY_LOG goes to opencode's own log file, WORKBUDDY_DEBUG=1
// mirrors the full trace to stderr.
// Run: node test/log.mjs
import { installLogSink, logError, logInfo, logPlugin, logWarn } from "../dist/log.js";
import { createV2Context } from "./helpers/v2-context.mjs";

// This file is about the log sink; the model catalogue must stay offline.
process.env.WORKBUDDY_DISABLE_MODEL_DISCOVERY = "1";

let fail = 0;
const check = (cond, msg) => {
  if (!cond) {
    console.log(`FAIL: ${msg}`);
    fail++;
  }
};

/** Run `fn` capturing everything it writes to stderr. */
function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

let sinkHits = [];
function armedSink() {
  sinkHits = [];
  installLogSink({
    app: {
      log: (args) => {
        sinkHits.push(args.body);
        return Promise.resolve({ data: true });
      },
    },
  });
}

function emitAll() {
  logPlugin("msg-debug");
  logInfo("msg-info");
  logWarn("msg-warn");
  logError("msg-error");
}

const stderrOf = (env) => {
  Object.assign(process.env, env);
  for (const key of ["WORKBUDDY_DEBUG", "WORKBUDDY_LOG"])
    if (!(key in env)) delete process.env[key];
  armedSink();
  const out = captureStderr(emitAll);
  return {
    out,
    sink: sinkHits.map((h) => `${h.level}:${h.message}`),
    terminal: {
      debug: out.includes("msg-debug"),
      info: out.includes("msg-info"),
      warn: out.includes("msg-warn"),
      error: out.includes("msg-error"),
    },
  };
};

// 1. Default: a clean terminal, lifecycle still recorded to the log file.
{
  const r = stderrOf({});
  console.log(`default terminal=${JSON.stringify(r.terminal)} sink=${r.sink.length}`);
  check(!r.terminal.debug && !r.terminal.info, "debug/info must not reach the terminal by default");
  check(r.terminal.warn && r.terminal.error, "warn/error must always reach the terminal");
  check(r.out.includes("[workbuddy] warn:"), "warn line should carry its level");
  check(
    r.sink.join() === "info:msg-info,warn:msg-warn,error:msg-error",
    `default sink floor is info, got ${r.sink}`,
  );
  check(
    sinkHits.every((h) => h.service === "workbuddy"),
    "sink entries must be tagged service=workbuddy",
  );
}

// 2. WORKBUDDY_DEBUG=1 restores the full stderr trace for CLI debugging.
{
  const r = stderrOf({ WORKBUDDY_DEBUG: "1" });
  console.log(`debug terminal=${JSON.stringify(r.terminal)} sink=${r.sink.length}`);
  check(
    Object.values(r.terminal).every(Boolean),
    "WORKBUDDY_DEBUG=1 must mirror every level to stderr",
  );
  check(r.sink.length === 4, "WORKBUDDY_DEBUG=1 must also lower the file floor to debug");
}

// 3. WORKBUDDY_LOG raises/lowers the file floor without touching the terminal rule.
{
  const dbg = stderrOf({ WORKBUDDY_LOG: "debug" });
  console.log(`log=debug sink=${dbg.sink.length} terminal.debug=${dbg.terminal.debug}`);
  check(dbg.sink.length === 4, "WORKBUDDY_LOG=debug sends everything to the log file");
  check(!dbg.terminal.debug, "WORKBUDDY_LOG alone must not clutter the terminal");

  const err = stderrOf({ WORKBUDDY_LOG: "error" });
  check(err.sink.join() === "error:msg-error", `WORKBUDDY_LOG=error floor, got ${err.sink}`);
  check(err.terminal.warn, "warn still shows even when the file floor is error");
}

// 4. WORKBUDDY_LOG=off is a full mute -- and a broken sink can never throw
//    out of a request path.
{
  const r = stderrOf({ WORKBUDDY_LOG: "off" });
  check(r.out === "", `off must write nothing, got ${JSON.stringify(r.out)}`);
  check(r.sink.length === 0, "off must not hit the log file either");
  delete process.env.WORKBUDDY_LOG; // back to default so the checks below can log

  installLogSink({
    app: {
      log: () => {
        throw new Error("sink exploded");
      },
    },
  });
  const guarded = captureStderr(emitAll);
  check(guarded.includes("msg-warn"), "a throwing sink must not swallow the terminal copy");

  installLogSink({ app: { log: () => Promise.reject(new Error("async sink exploded")) } });
  captureStderr(emitAll);
  await new Promise((resolve) => setTimeout(resolve, 10));

  installLogSink(undefined);
  installLogSink({ app: {} });
  check(true, "missing client / missing app.log must be inert");
}

// 5. With a sink installed, v2 setup() records lifecycle lines in the log file.
//    v2's PluginContext carries no client, so the sink is installed explicitly
//    here rather than by a v1 server() hook that no longer exists.
{
  const { definePlugin } = await import("../dist/index.js");
  const { ctx, state } = createV2Context({});
  const logged = [];
  const client = {
    app: {
      log: (a) => {
        logged.push(a.body.message);
        return Promise.resolve({ data: true });
      },
    },
  };
  installLogSink(client);
  await definePlugin("cn").setup(ctx);
  await new Promise((resolve) => setTimeout(resolve, 10));
  installLogSink(undefined);
  console.log(
    `via setup(): ${logged.length} entr${logged.length === 1 ? "y" : "ies"} to the log file`,
  );
  check(
    logged.some((m) => /registering \d+ models for cn/.test(m)),
    "setup() must log model registration to the sink",
  );
  check(
    state.providers.some((p) => p.info.id === "workbuddy-cn"),
    "provider still registered while logging",
  );
}

if (fail) {
  console.log(`FAIL x${fail}`);
  process.exit(1);
}
console.log("PASS");
