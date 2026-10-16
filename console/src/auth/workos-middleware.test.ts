import { authkitMiddleware } from "@workos/authkit-astro";
import { configure, getConfig } from "@workos/authkit-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetKeyCache, type WorkosEnv } from "./workos-config";
import {
  anonymousAuth,
  authConfig,
  createWorkosMiddleware,
  type MiddlewareContext,
} from "./workos-middleware-core";
import { requireConfigured } from "./workos-guard";

// The REAL package middleware (no network: an anonymous request needs none).
const authkit = authkitMiddleware({
  protectedRoutes: ["/api/stations"],
  signInPath: "/auth/signin",
});

const PASSWORD = "p".repeat(40);
const STORE_KEY = "sk_test_from_secrets_store";

function env(over: Partial<WorkosEnv> = {}): WorkosEnv {
  return {
    WORKOS_CLIENT_ID: "client_01KQBBSMQTSMTBN7HEC9KQBJC0",
    WORKOS_REDIRECT_URI: "https://weatherstations.nyuchi.com/callback",
    WORKOS_COOKIE_PASSWORD: PASSWORD,
    CONSOLE_WORKOS_API_KEY: { get: async () => STORE_KEY },
    ...over,
  };
}

function middleware(getEnv: () => WorkosEnv, prod = true) {
  return createWorkosMiddleware({
    getEnv,
    prod,
    authkit: authkit as never,
    configure: configure as never,
  });
}

function ctx(path: string, accept: string): MiddlewareContext & Record<string, unknown> {
  const url = new URL(`https://weatherstations.nyuchi.com${path}`);
  const cookies = {
    get: () => undefined,
    has: () => false,
    set: () => undefined,
    delete: () => undefined,
  };
  return {
    url,
    request: new Request(url, { headers: { accept } }),
    cookies,
    locals: {},
    isPrerendered: false,
    redirect: (to: string, status = 302) =>
      new Response(null, { status, headers: { Location: to } }),
  } as never;
}

const next = async () => new Response("page", { status: 200 });

beforeEach(() => {
  resetKeyCache();
  delete process.env.WORKOS_API_KEY;
});
afterEach(() => {
  delete process.env.WORKOS_API_KEY;
  delete process.env.WORKOS_COOKIE_PASSWORD;
  delete process.env.WORKOS_CLIENT_ID;
  delete process.env.WORKOS_REDIRECT_URI;
});

describe("happy path: AuthKit takes the Secrets Store value", () => {
  it("configures AuthKit with the store key and the other settings", async () => {
    const mw = middleware(() => env());
    const c = ctx("/", "text/html");
    const res = await mw(c, next);
    expect(res.status).toBe(200);
    expect(c.locals.workosConfigOk).toBe(true);
    expect(getConfig("apiKey")).toBe(STORE_KEY);
    expect(getConfig("clientId")).toBe("client_01KQBBSMQTSMTBN7HEC9KQBJC0");
    expect(getConfig("cookiePassword")).toBe(PASSWORD);
    // Hardened session cookie: __Host- prefix over https, a week, not 400 days.
    expect(getConfig("cookieName")).toBe("__Host-wos-session");
    expect(getConfig("cookieMaxAge")).toBe(60 * 60 * 24 * 7);
  });

  it("is not overridden by leftover plain Worker secrets or process.env", async () => {
    process.env.WORKOS_API_KEY = "sk_leftover_plain_secret";
    process.env.WORKOS_COOKIE_PASSWORD = "x".repeat(40);
    process.env.WORKOS_CLIENT_ID = "client_leftover";
    process.env.WORKOS_REDIRECT_URI = "https://evil.test/callback";
    await middleware(() => env())(ctx("/", "text/html"), next);
    expect(getConfig("apiKey")).toBe(STORE_KEY);
    expect(getConfig("clientId")).toBe("client_01KQBBSMQTSMTBN7HEC9KQBJC0");
    expect(getConfig("cookiePassword")).toBe(PASSWORD);
    expect(getConfig("redirectUri")).toBe("https://weatherstations.nyuchi.com/callback");
  });

  it("keeps the library cookie name over plain http (local dev)", () => {
    const c = authConfig({
      clientId: "c",
      apiKey: "k",
      redirectUri: "http://localhost:4321/callback",
      cookiePassword: PASSWORD,
    });
    expect(c.cookieName).toBeUndefined();
  });
});

describe("anonymous /api/stations", () => {
  it("is 401 JSON for Accept: application/json", async () => {
    const res = await middleware(() => env())(ctx("/api/stations", "application/json"), next);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("is a 302 to sign-in for an HTML request", async () => {
    const res = await middleware(() => env())(ctx("/api/stations", "text/html"), next);
    expect(res.status).toBe(302);
  });
});

describe("fail closed", () => {
  it("answers a JSON 500 for /api when config is missing, naming no value", async () => {
    const mw = middleware(() => env({ CONSOLE_WORKOS_API_KEY: { get: async () => { throw new Error("sk_leak"); } } }));
    const c = ctx("/api/stations", "application/json");
    const res = await mw(c, next);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.text();
    expect(body).toContain("not configured correctly");
    expect(body).not.toMatch(/sk_|WORKOS|CONSOLE_/);
    expect(c.locals.workosConfigOk).toBe(false);
  });

  it("serves pages signed-out with a full-shape auth that refuses to redirect", async () => {
    const mw = middleware(() => env({ WORKOS_COOKIE_PASSWORD: undefined }));
    const c = ctx("/", "text/html");
    const res = await mw(c, next);
    expect(res.status).toBe(200);
    const auth = c.locals.auth as ReturnType<typeof anonymousAuth>;
    expect(auth.user).toBeNull();
    expect(auth.has()).toBe(false);
    expect(() => auth.redirectToSignIn()).toThrow(/not configured/);
  });

  it("flags a request after a transient failure, so the injected routes refuse", async () => {
    let fail = false;
    const mw = middleware(() =>
      env({
        CONSOLE_WORKOS_API_KEY: {
          get: async () => {
            if (fail) throw new Error("down");
            return STORE_KEY;
          },
        },
      }),
    );
    const ok = ctx("/auth/signin", "text/html");
    await mw(ok, next);
    expect(ok.locals.workosConfigOk).toBe(true);

    resetKeyCache(); // the cached key would otherwise cover the outage
    fail = true;
    const bad = ctx("/auth/signin", "text/html");
    await mw(bad, next);
    expect(bad.locals.workosConfigOk).toBe(false);

    const sign = vi.fn(async () => new Response("redirect", { status: 302 }));
    const guarded = requireConfigured(sign as never);
    const refused = await guarded(bad as never);
    expect(refused instanceof Response && refused.status).toBe(500);
    expect(sign).not.toHaveBeenCalled();
    await guarded(ok as never);
    expect(sign).toHaveBeenCalledOnce();
  });

  it("rejects a plain string key in production", async () => {
    const mw = middleware(() => env({ CONSOLE_WORKOS_API_KEY: "sk_plain" }), true);
    const c = ctx("/api/stations", "application/json");
    expect((await mw(c, next)).status).toBe(500);
    const dev = middleware(() => env({ CONSOLE_WORKOS_API_KEY: "sk_plain" }), false);
    expect((await dev(ctx("/api/stations", "application/json"), next)).status).toBe(401);
  });

  it("skips the secret read for a prerendered page", async () => {
    const get = vi.fn(async () => STORE_KEY);
    const c = ctx("/about", "text/html");
    c.isPrerendered = true;
    const res = await middleware(() => env({ CONSOLE_WORKOS_API_KEY: { get } }))(c, next);
    expect(res.status).toBe(200);
    expect(get).not.toHaveBeenCalled();
  });
});
