import { describe, expect, it } from "vitest";
import { FAILED_BODY, GET } from "./workos-callback";

function call(search: string, configured = true) {
  const url = new URL(`https://weatherstations.nyuchi.com/callback${search}`);
  return GET({
    url,
    request: new Request(url),
    locals: { workosConfigOk: configured },
    cookies: { get: () => undefined, set: () => undefined, delete: () => undefined },
    redirect: (to: string) => new Response(null, { status: 302, headers: { Location: to } }),
  } as never) as Promise<Response>;
}

describe("/callback", () => {
  it("answers a fixed message for a WorkOS error, reflecting nothing", async () => {
    const res = await call("?error=access_denied&error_description=%3Cscript%3Ealert(1)%3C/script%3E");
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toBe(FAILED_BODY);
    expect(body).not.toMatch(/access_denied|script/);
  });

  it("answers the same fixed message when the code is missing", async () => {
    const res = await call("");
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(FAILED_BODY);
  });

  it("refuses outright when this request has no valid config", async () => {
    const res = await call("?code=abc", false);
    expect(res.status).toBe(500);
  });
});
