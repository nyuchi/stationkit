import { describe, expect, it, vi } from "vitest";
import {
  ENSURE_PATH,
  MAX_CACHED_TOKENS,
  type Send,
  TOKEN_PATH,
  TokenBroker,
  type UpstreamRequest,
} from "./nyuchi-token";
import { StationsApiError } from "./types";

const credentials = { clientId: "nyk_unit", clientSecret: "nys_unit_secret" };

const token = (n: number, over: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    access_token: `jwt-${n}`,
    issued_token_type: "urn:ietf:params:oauth:token-type:jwt",
    token_type: "Bearer",
    expires_in: 900,
    scope: "stations",
    ...over,
  },
});
const oauth = (status: number, error: string) => ({
  status,
  body: { detail: { error, error_description: "x" } },
});

/**
 * A scripted API: each call to `send` takes the next reply, after a short
 * delay like a network's, so callers that ask together really do overlap.
 */
function scripted(...replies: ({ status: number; body: unknown } | Error)[]) {
  const seen: UpstreamRequest[] = [];
  const send: Send = vi.fn(async (req: UpstreamRequest) => {
    seen.push(req);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const next = replies.shift();
    if (!next) throw new Error("unscripted request");
    if (next instanceof Error) throw next;
    return next;
  });
  return { send, seen };
}

const failing = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(StationsApiError);
  return e as StationsApiError;
};

describe("TokenBroker", () => {
  it("asks for the stations scope only, with the console's key in the form and the headers", async () => {
    const { send, seen } = scripted(token(1));
    await new TokenBroker(credentials, send).token("subject-1");
    const req = seen[0]!;
    expect(req.path).toBe(TOKEN_PATH);
    expect(req.headers["X-Client-Id"]).toBe("nyk_unit");
    expect(req.headers["X-Client-Secret"]).toBe("nys_unit_secret");
    const form = new URLSearchParams(req.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: "subject-1",
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "stations",
      client_id: "nyk_unit",
      client_secret: "nys_unit_secret",
    });
  });

  it("keeps a token for its life less a margin, then exchanges again", async () => {
    let t = 0;
    const { send } = scripted(token(1), token(2));
    const broker = new TokenBroker(credentials, send, () => t);
    expect(await broker.token("s")).toEqual({ token: "jwt-1", cached: false });
    t = 869_000;
    expect(await broker.token("s")).toEqual({ token: "jwt-1", cached: true });
    t = 871_000;
    expect(await broker.token("s")).toEqual({ token: "jwt-2", cached: false });
  });

  it("never holds a token longer than fifteen minutes, whatever the API says", async () => {
    let t = 0;
    const { send } = scripted(token(1, { expires_in: 86_400 }), token(2));
    const broker = new TokenBroker(credentials, send, () => t);
    await broker.token("s");
    t = 15 * 60_000;
    expect((await broker.token("s")).token).toBe("jwt-2");
  });

  it("does not keep a token with no usable lifetime", async () => {
    const { send } = scripted(
      token(1, { expires_in: 0 }),
      token(2, { expires_in: "soon" }),
      token(3),
    );
    const broker = new TokenBroker(credentials, send);
    expect((await broker.token("s")).token).toBe("jwt-1");
    expect((await broker.token("s")).token).toBe("jwt-2");
    expect((await broker.token("s")).token).toBe("jwt-3");
  });

  it("keys the cache on the AuthKit token, so a refreshed one is exchanged again", async () => {
    const { send } = scripted(token(1), token(2));
    const broker = new TokenBroker(credentials, send);
    await broker.token("authkit-v1");
    expect((await broker.token("authkit-v2")).token).toBe("jwt-2");
  });

  it("forgets a token on request", async () => {
    const { send } = scripted(token(1), token(2));
    const broker = new TokenBroker(credentials, send);
    await broker.token("s");
    await broker.forget("s");
    expect((await broker.token("s")).token).toBe("jwt-2");
  });

  it("shares one exchange between callers that ask together, and one failure too", async () => {
    const ok = scripted(token(1));
    const broker = new TokenBroker(credentials, ok.send);
    const got = await Promise.all([
      broker.token("s"),
      broker.token("s"),
      broker.token("s"),
    ]);
    expect(got.map((g) => g.token)).toEqual(["jwt-1", "jwt-1", "jwt-1"]);
    expect(ok.send).toHaveBeenCalledTimes(1);

    const bad = scripted(oauth(400, "invalid_grant"), token(2));
    const b2 = new TokenBroker(credentials, bad.send);
    const results = await Promise.allSettled([b2.token("s"), b2.token("s")]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(bad.send).toHaveBeenCalledTimes(1);
    // The failure was not kept: the next call tries again.
    expect((await b2.token("s")).token).toBe("jwt-2");
  });

  it("provisions an unknown person once, then exchanges again", async () => {
    const { send, seen } = scripted(
      oauth(404, "person_not_found"),
      { status: 201, body: { person_id: "p", created: true } },
      token(1),
    );
    const broker = new TokenBroker(credentials, send);
    expect((await broker.token("s")).token).toBe("jwt-1");
    expect(seen.map((r) => r.path)).toEqual([
      TOKEN_PATH,
      ENSURE_PATH,
      TOKEN_PATH,
    ]);
    expect(JSON.parse(seen[1]!.body ?? "{}")).toEqual({
      subject_token: "s",
      subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    });
    expect(seen[1]!.headers["Content-Type"]).toBe("application/json");
    expect(seen[1]!.headers["X-Client-Id"]).toBe("nyk_unit");
  });

  it("accepts a person who already existed (200) and gives up if still not found", async () => {
    const existing = scripted(
      oauth(404, "person_not_found"),
      { status: 200, body: { person_id: "p", created: false } },
      token(1),
    );
    expect(
      (await new TokenBroker(credentials, existing.send).token("s")).token,
    ).toBe("jwt-1");

    const stuck = scripted(
      oauth(404, "person_not_found"),
      { status: 200, body: {} },
      oauth(404, "person_not_found"),
    );
    expect(
      (await failing(new TokenBroker(credentials, stuck.send).token("s")))
        .status,
    ).toBe(502);
    expect(stuck.send).toHaveBeenCalledTimes(3);
  });

  it("does not take a 404 without the person_not_found code for a missing person", async () => {
    const { send } = scripted({ status: 404, body: { detail: "Not Found" } });
    const e = await failing(new TokenBroker(credentials, send).token("s"));
    expect(e.status).toBe(502);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "provisioning is refused: email not verified",
      403,
      "email_not_verified",
      403,
    ],
    ["provisioning is rate limited", 429, "slow_down", 429],
    ["identity is down", 503, "temporarily_unavailable", 503],
    ["the console's key is wrong", 401, "invalid_client", 502],
  ])("maps a failed ensure when %s", async (_what, status, error, mapped) => {
    const { send } = scripted(
      oauth(404, "person_not_found"),
      oauth(status, error),
    );
    const e = await failing(new TokenBroker(credentials, send).token("s"));
    expect(e.status).toBe(mapped);
  });

  it("refuses an answer that is not a token for the stations scope", async () => {
    for (const reply of [
      token(1, { scope: "identity" }),
      token(1, { scope: "" }),
      token(1, { scope: undefined }),
      token(1, { access_token: "" }),
      token(1, { access_token: 5 }),
      { status: 200, body: null },
      { status: 200, body: "jwt" },
    ]) {
      const { send } = scripted(reply);
      expect(
        (await failing(new TokenBroker(credentials, send).token("s"))).status,
      ).toBe(502);
    }
  });

  it("carries nothing of the subject token or the key in what it throws", async () => {
    const { send } = scripted(oauth(400, "invalid_grant"));
    const e = await failing(
      new TokenBroker(credentials, send).token("SUBJECT-SECRET"),
    );
    expect(
      JSON.stringify([e.message, e.status, e.stack?.split("\n")[0]]),
    ).not.toMatch(/SUBJECT-SECRET|nys_unit_secret/);
  });

  it("lets a network failure through as the station service being unreachable", async () => {
    const { send } = scripted(
      new StationsApiError(502, "The station service is unreachable"),
    );
    expect(
      (await failing(new TokenBroker(credentials, send).token("s"))).message,
    ).toMatch(/unreachable/);
  });

  it("is bounded: the oldest token goes first", async () => {
    const replies = Array.from({ length: MAX_CACHED_TOKENS + 2 }, (_, i) =>
      token(i),
    );
    const { send } = scripted(...replies, token(999));
    const broker = new TokenBroker(credentials, send);
    for (let i = 0; i < MAX_CACHED_TOKENS + 1; i++)
      await broker.token(`s-${i}`);
    // The first person's token was pushed out; the latest is still held.
    expect((await broker.token(`s-${MAX_CACHED_TOKENS}`)).cached).toBe(true);
    expect((await broker.token("s-0")).cached).toBe(false);
  });
});
