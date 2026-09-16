// Isolation + fault-tolerance contract for the billing tools.
//
// The daily check-in is a MUTATION against a campaign endpoint that may
// disappear, change shape, start rate-limiting, or stop working at any time.
// None of that is allowed to disturb the chat plugin. This suite proves it:
// every conceivable billing failure is *returned*, never thrown; and the
// kill-switch envs stop the network call before credentials are even resolved.
//
// Nothing here touches the network or a real credential store: fetch is mocked
// and XDG_CONFIG_HOME points at a throwaway sandbox.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "wb-quota-"));
process.env.XDG_CONFIG_HOME = join(sandbox, "config");
process.env.HOME = sandbox;
delete process.env.WORKBUDDY_TOKEN;
delete process.env.WORKBUDDY_CN_TOKEN;
delete process.env.WORKBUDDY_DISABLE_BILLING;
delete process.env.WORKBUDDY_DISABLE_CHECKIN;

const { fetchQuota, dailyCheckin, formatQuota, parseExpiryMs } = await import("../dist/quota.js");
const { PROVIDER_ID_CN, CN_STORE_NAME } = await import("../dist/constants.js");

let failures = 0;
const check = (ok, what) => {
  if (!ok) {
    failures += 1;
    console.log(`  FAIL  ${what}`);
  } else {
    console.log(`  ok    ${what}`);
  }
};

// A fresh, self-consistent credential so resolution needs no network + no
// refresh side effects. Domain is set so postBilling reaches fetch at all.
const STORE_DIR = join(process.env.XDG_CONFIG_HOME, "opencode");
const STORE_FILE = join(STORE_DIR, CN_STORE_NAME);
mkdirSync(STORE_DIR, { recursive: true });
const cred = {
  version: 1,
  credential: {
    accessToken: "fake-token-do-not-send-anywhere",
    refreshToken: "",
    expiresAtMs: Date.now() + 3_600_000,
    uid: "100001",
    nickname: "sandbox",
    domain: "www.workbuddy.cn",
    enterpriseId: "ent-1",
  },
};
writeFileSync(STORE_FILE, `${JSON.stringify(cred, null, 2)}\n`, { mode: 0o600 });
const credBytesBefore = readFileSync(STORE_FILE);

const options = { providerID: PROVIDER_ID_CN, storeName: CN_STORE_NAME };

// --- fetch mock -------------------------------------------------------------
const realFetch = globalThis.fetch;
let calls = [];
function mockFetch(behaviour) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return behaviour(url, init);
  };
}
function restore() {
  globalThis.fetch = realFetch;
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function credentialBytesUnchanged(label) {
  check(
    Buffer.compare(credBytesBefore, readFileSync(STORE_FILE)) === 0,
    `credential file untouched: ${label}`,
  );
}

// --- 1. transport failure (campaign gone, DNS dead, abort, refused) ---------
{
  mockFetch(() => {
    throw new TypeError("fetch failed");
  });
  const q = await fetchQuota("cn", options);
  const c = await dailyCheckin("cn", options);
  restore();
  check(q.ok === false && q.disabled !== true, "fetch throw -> quota ok:false");
  check(typeof q.error === "string" && q.error.length > 0, "quota error message set");
  check(c.status === "failed", "fetch throw -> checkin failed");
  check(calls.length === 2, "both paths made exactly one call");
  credentialBytesUnchanged("transport failure");
}

// --- 2. HTTP 500 with a business code (credit-exhausted 14018 shape) -------
{
  mockFetch(() => jsonResponse(500, { code: 14018, msg: "credit exhausted" }));
  const q = await fetchQuota("cn", options);
  const c = await dailyCheckin("cn", options);
  restore();
  check(q.ok === false && /14018/.test(q.error ?? ""), "500 code surfaced in quota error");
  check(c.status === "failed" && /14018/.test(c.message), "500 code surfaced in checkin msg");
  credentialBytesUnchanged("http 500");
}

// --- 2b. 401: the gateway rejects the credential ---------------------------
// This is the case where a naive implementation "helpfully" clears or marks the
// credential invalid, logging the user out of chat because a *balance read*
// failed. The billing path must never touch credential state.
{
  mockFetch(() => jsonResponse(401, { code: 401, msg: "unauthorized" }));
  const q = await fetchQuota("cn", options);
  const c = await dailyCheckin("cn", options);
  restore();
  check(q.ok === false && /401/.test(q.error ?? ""), "401 -> quota ok:false");
  check(c.status === "failed", "401 -> checkin failed");
  credentialBytesUnchanged("http 401 -- no logout, no invalidation");
  check(existsSync(STORE_FILE), "401 left the credential store in place");
}

// --- 3. endpoint changed shape -> HTML login wall instead of JSON -----------
{
  mockFetch(
    () =>
      new Response("<!doctype html><html>please log in</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  );
  const q = await fetchQuota("cn", options);
  const c = await dailyCheckin("cn", options);
  restore();
  check(q.ok === false, "HTML body -> quota ok:false (no crash)");
  check(c.status === "failed", "HTML body -> checkin failed");
  credentialBytesUnchanged("html instead of json");
}

// --- 4. success envelope but no usable data (endpoint quietly emptied) -----
{
  mockFetch(() => jsonResponse(200, { code: 0, msg: "", data: { Response: { Data: {} } } }));
  const q = await fetchQuota("cn", options);
  restore();
  check(q.ok === true, "empty Accounts -> still ok:true (no data is data)");
  check(Array.isArray(q.packages) && q.packages.length === 0, "no packages parsed");
  check(q.totalRemain === 0 && q.soonestExpiryMs === 0, "totals stay zero");
  check(formatQuota(q).includes("no packages reported"), "renderer handles empty set");
}

// --- 5. already-checked-in is a RESULT, not a fault (code 10001) -----------
{
  mockFetch(() => jsonResponse(200, { code: 10001, msg: "今天已签到，请明天再来", data: {} }));
  const c = await dailyCheckin("cn", options);
  restore();
  check(c.status === "already", "10001 -> status already (not failed)");
  check(c.message.includes("已签到"), "gateway message preserved");
}

// --- 6. claimed mints credits (code 0) -------------------------------------
{
  mockFetch((url) =>
    String(url).includes("get-user-resource")
      ? jsonResponse(200, {
          code: 0,
          data: {
            Response: {
              Data: {
                Accounts: [
                  {
                    PackageCode: "TCACA_checkin",
                    PackageName: "check-in",
                    CycleCapacityRemain: "100",
                    CycleCapacitySize: "100",
                    Status: 0,
                    DeductionEndTime: 1790565194000,
                  },
                ],
                TotalDosage: 100,
              },
            },
          },
        })
      : jsonResponse(200, { code: 0, msg: "签到成功", data: {} }),
  );
  const c = await dailyCheckin("cn", options);
  const q = await fetchQuota("cn", options);
  restore();
  check(c.status === "claimed", "code 0 -> claimed");
  check(
    q.ok && q.packages[0].remain === 100 && q.packages[0].name === "check-in",
    "string-number capacity coerced to number",
  );
  check(q.reportedTotal === 100, "gateway TotalDosage cross-check captured");
}

// --- 7. campaign vanished: 404 ---------------------------------------------
{
  mockFetch(() => new Response("not found", { status: 404 }));
  const c = await dailyCheckin("cn", options);
  const q = await fetchQuota("cn", options);
  restore();
  check(c.status === "failed" && /404/.test(c.message), "404 -> failed with status in message");
  check(q.ok === false, "404 -> quota ok:false");
  credentialBytesUnchanged("404 campaign gone");
}

// --- 8. kill-switches short-circuit BEFORE touching the network ------------
{
  mockFetch(() => jsonResponse(200, { code: 0, data: {} }));
  process.env.WORKBUDDY_DISABLE_CHECKIN = "1";
  const c = await dailyCheckin("cn", options);
  check(c.status === "disabled", "DISABLE_CHECKIN -> status disabled");
  check(calls.length === 0, "DISABLE_CHECKIN -> zero network calls");
  check(/WORKBUDDY_DISABLE_CHECKIN/.test(c.message), "disabled message names the switch");
  const q = await fetchQuota("cn", options);
  check(q.ok === true, "DISABLE_CHECKIN leaves balance available (read-only is fine)");

  process.env.WORKBUDDY_DISABLE_BILLING = "1";
  calls = [];
  const c2 = await dailyCheckin("cn", options);
  const q2 = await fetchQuota("cn", options);
  restore();
  delete process.env.WORKBUDDY_DISABLE_CHECKIN;
  delete process.env.WORKBUDDY_DISABLE_BILLING;
  check(c2.status === "disabled", "umbrella DISABLE_BILLING -> checkin disabled");
  check(q2.ok === false && q2.disabled === true, "umbrella -> quota disabled flag");
  check(formatQuota(q2).includes("Balance reporting disabled"), "quota renderer says disabled");
  check(calls.length === 0, "umbrella -> zero network calls");
  credentialBytesUnchanged("kill-switches");
}

// --- 8b. credentials are NEVER resolved when billing is disabled ------------
{
  // Remove the store entirely: if the disable short-circuit regressed to after
  // resolveWorkBuddyCredentials, this would fail with "credentials not found"
  // instead of the disabled notice.
  rmSync(STORE_FILE);
  process.env.WORKBUDDY_DISABLE_BILLING = "1";
  const q = await fetchQuota("cn", options);
  const c = await dailyCheckin("cn", options);
  delete process.env.WORKBUDDY_DISABLE_BILLING;
  check(q.disabled === true, "disabled+no-creds: quota disabled, NOT an auth error");
  check(c.status === "disabled", "disabled+no-creds: checkin disabled, NOT an auth error");
  writeFileSync(STORE_FILE, credBytesBefore, { mode: 0o600 });
}

// --- 9. expiry parser is total ---------------------------------------------
check(parseExpiryMs(1790565194000) > 0, "epoch millis parsed");
check(parseExpiryMs(1790565194) > 0, "epoch seconds promoted to millis");
check(parseExpiryMs("2026-09-30 23:59:59") > 0, "space-separated datetime parsed");
check(parseExpiryMs("2026-09-30T23:59:59+08:00") > 0, "offset datetime parsed");
check(parseExpiryMs("garbage") === 0, "garbage -> 0 (unknown), never throws");
check(parseExpiryMs(undefined) === 0, "undefined -> 0");
check(parseExpiryMs(null) === 0, "null -> 0");
check(parseExpiryMs(0) === 0, "zero -> 0");
check(parseExpiryMs(-5) === 0, "negative -> 0");
check(parseExpiryMs(Number.NaN) === 0, "NaN -> 0");
check(parseExpiryMs([]) === 0, "array -> 0");
check(parseExpiryMs({}) === 0, "object -> 0");

// --- 10. quota never becomes an auth dependency -----------------------------
{
  rmSync(STORE_FILE);
  mockFetch(() => jsonResponse(200, { code: 0, data: {} }));
  const q = await fetchQuota("cn", options);
  restore();
  check(
    q.ok === false && /credentials not found/i.test(q.error ?? ""),
    "no creds -> graceful ok:false",
  );
  // The failure must not have re-created or mutated any store file.
  check(!existsSync(STORE_FILE), "quota failure did not write a credential store");
}

// --- 11. total billing outage cannot disturb the plugin ---------------------
// The user's actual requirement: the campaign may vanish, change shape, or stop
// working at any time, and none of it may touch the chat plugin. Simulate the
// worst case -- every billing request throws -- then assert the plugin still
// boots, still registers its tools, a NON-billing tool still answers, and each
// billing tool degrades to a returned message rather than an exception.
{
  // Section 10 removed the store to prove graceful no-creds handling; restore
  // it so this section tests a *billing* outage, not an auth outage.
  writeFileSync(STORE_FILE, credBytesBefore, { mode: 0o600 });
  globalThis.fetch = async () => {
    throw new TypeError("simulated total billing outage");
  };
  const mod = await import("../dist/index.js");
  const hooks = await mod.definePlugin("cn").server({ client: undefined }, {});
  const toolNames = Object.keys(hooks.tool ?? {});
  check(
    ["workbuddy_cn_account", "workbuddy_cn_quota", "workbuddy_cn_checkin"].every((t) =>
      toolNames.includes(t),
    ),
    `all 3 tools still registered during outage (${toolNames.join(",")})`,
  );

  const acct = await hooks.tool.workbuddy_cn_account.execute({}, {});
  check(/provider=workbuddy-cn/.test(acct.output), "non-billing account tool unaffected");

  let threw = false;
  try {
    const q = await hooks.tool.workbuddy_cn_quota.execute({}, {});
    check(q.ok !== true && /unavailable/i.test(q.output), "quota tool degrades to a message");
    check(
      q.data?.ok === false && Array.isArray(q.data?.packages),
      "quota tool data stays structured",
    );
  } catch {
    threw = true;
  }
  check(!threw, "quota tool never throws into the dispatcher");

  threw = false;
  try {
    const c = await hooks.tool.workbuddy_cn_checkin.execute({}, {});
    check(c.data?.status === "failed", "checkin tool reports failed during outage");
  } catch {
    threw = true;
  }
  check(!threw, "checkin tool never throws into the dispatcher");

  restore();
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`);
if (failures > 0) process.exit(1);
