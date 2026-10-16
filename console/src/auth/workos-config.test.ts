import { beforeEach, describe, expect, it } from "vitest";
import {
  API_KEY_BINDING,
  fingerprint,
  KEY_CACHE_TTL_MS,
  MIN_COOKIE_PASSWORD_LENGTH,
  resetKeyCache,
  resolveWorkosConfig,
  type WorkosEnv,
} from "./workos-config";

const PASSWORD = "p".repeat(MIN_COOKIE_PASSWORD_LENGTH);
const base = (over: Partial<WorkosEnv> = {}): WorkosEnv => ({
  WORKOS_CLIENT_ID: "client_01KQBBSMQTSMTBN7HEC9KQBJC0",
  WORKOS_REDIRECT_URI: "https://weatherstations.nyuchi.com/callback",
  WORKOS_COOKIE_PASSWORD: PASSWORD,
  CONSOLE_WORKOS_API_KEY: { get: async () => "sk_test_secret_value" },
  ...over,
});

describe("resolveWorkosConfig", () => {
  beforeEach(resetKeyCache);

  it("reads the API key from the Secrets Store binding at runtime", async () => {
    let calls = 0;
    const r = await resolveWorkosConfig(
      base({
        CONSOLE_WORKOS_API_KEY: {
          get: async () => {
            calls++;
            return "sk_test_secret_value";
          },
        },
      }),
    );
    expect(r).toEqual({
      ok: true,
      config: {
        clientId: "client_01KQBBSMQTSMTBN7HEC9KQBJC0",
        apiKey: "sk_test_secret_value",
        redirectUri: "https://weatherstations.nyuchi.com/callback",
        cookiePassword: PASSWORD,
      },
    });
    expect(calls).toBe(1);
    expect(API_KEY_BINDING).toBe("CONSOLE_WORKOS_API_KEY");
  });

  it("accepts a plain string key for local development only", async () => {
    const r = await resolveWorkosConfig(base({ CONSOLE_WORKOS_API_KEY: "sk_local" }));
    expect(r.ok && r.config.apiKey).toBe("sk_local");
  });

  it("fails closed when the binding is missing, empty, or its read throws", async () => {
    for (const binding of [
      undefined,
      null,
      "",
      {},
      { get: async () => null },
      { get: async () => "" },
      {
        get: async () => {
          throw new Error("store unreachable: sk_test_leak");
        },
      },
    ]) {
      const r = await resolveWorkosConfig(base({ CONSOLE_WORKOS_API_KEY: binding }));
      expect(r).toEqual({ ok: false, problems: [API_KEY_BINDING] });
    }
  });

  it("keeps the cookie password a separate, length-checked secret", async () => {
    const none = await resolveWorkosConfig(base({ WORKOS_COOKIE_PASSWORD: undefined }));
    expect(none).toEqual({ ok: false, problems: ["WORKOS_COOKIE_PASSWORD"] });
    const short = await resolveWorkosConfig(base({ WORKOS_COOKIE_PASSWORD: "short" }));
    expect(short.ok).toBe(false);
    expect(!short.ok && short.problems[0]).toMatch(/shorter than 32/);
  });

  it("requires the client id and an https redirect URI", async () => {
    expect(await resolveWorkosConfig(base({ WORKOS_CLIENT_ID: "  " }))).toEqual({
      ok: false,
      problems: ["WORKOS_CLIENT_ID"],
    });
    const http = await resolveWorkosConfig(base({ WORKOS_REDIRECT_URI: "http://evil.test/callback" }));
    expect(!http.ok && http.problems[0]).toMatch(/https/);
    const junk = await resolveWorkosConfig(base({ WORKOS_REDIRECT_URI: "nope" }));
    expect(!junk.ok && junk.problems[0]).toMatch(/not a URL/);
    expect((await resolveWorkosConfig(base({ WORKOS_REDIRECT_URI: "http://localhost:4321/callback" }))).ok).toBe(true);
  });

  it("names settings only, never a value, in any failure", async () => {
    const r = await resolveWorkosConfig(
      base({
        WORKOS_CLIENT_ID: undefined,
        CONSOLE_WORKOS_API_KEY: { get: async () => { throw new Error("sk_test_secret_value"); } },
        WORKOS_COOKIE_PASSWORD: "tiny-secret-pw",
      }),
    );
    const out = JSON.stringify(r);
    expect(out).not.toContain("sk_test");
    expect(out).not.toContain("tiny-secret-pw");
  });

  it("refuses a plain string key in production, accepts it in development", async () => {
    const str = base({ CONSOLE_WORKOS_API_KEY: "sk_local" });
    expect(await resolveWorkosConfig(str, { prod: true })).toEqual({
      ok: false,
      problems: [API_KEY_BINDING],
    });
    expect((await resolveWorkosConfig(str, { prod: false })).ok).toBe(true);
  });

  it("caches the Secrets Store read for a short time and drops it on a failure", async () => {
    let calls = 0;
    let fail = false;
    const env = base({
      CONSOLE_WORKOS_API_KEY: {
        get: async () => {
          calls++;
          if (fail) throw new Error("down");
          return "key-" + calls;
        },
      },
    });
    let t = 1_000;
    const opts = { now: () => t };
    const first = await resolveWorkosConfig(env, opts);
    t += KEY_CACHE_TTL_MS - 1;
    const second = await resolveWorkosConfig(env, opts);
    expect(calls).toBe(1);
    expect(first.ok && second.ok && first.config.apiKey === second.config.apiKey).toBe(true);
    t += 2; // past the TTL: read again (a rotation is picked up)
    const third = await resolveWorkosConfig(env, opts);
    expect(calls).toBe(2);
    expect(third.ok && third.config.apiKey).toBe("key-2");
    t += KEY_CACHE_TTL_MS + 1;
    fail = true;
    expect((await resolveWorkosConfig(env, opts)).ok).toBe(false);
    fail = false;
    // The failed read dropped the cache, so the next call reads afresh.
    const callsBefore = calls;
    expect((await resolveWorkosConfig(env, opts)).ok).toBe(true);
    expect(calls).toBe(callsBefore + 1);
  });
});

describe("fingerprint", () => {
  const cfg = {
    clientId: "client_x",
    apiKey: "sk_a",
    redirectUri: "https://x.test/callback",
    cookiePassword: PASSWORD,
  };

  it("is a deterministic digest that changes with any value and exposes none", async () => {
    const a = await fingerprint(cfg);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprint({ ...cfg })).toBe(a);
    expect(await fingerprint({ ...cfg, apiKey: "sk_b" })).not.toBe(a);
    expect(await fingerprint({ ...cfg, cookiePassword: "q".repeat(32) })).not.toBe(a);
    expect(a).not.toContain("sk_a");
  });
});
