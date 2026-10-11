// Post-deploy smoke for the StationKit console. Reads one input, SMOKE_URL, and
// prints check names only: never response bodies, headers, or any secret.
//
//   GET /              200, StationKit landing, security headers, strict CSP
//   GET /api/stations  401 JSON when anonymous. A 500 means the WorkOS
//                      configuration (Secrets Store key, cookie password) is
//                      missing or wrong, and fails the deploy check.
const raw = process.env.SMOKE_URL;
if (!raw) {
  console.error("SMOKE_URL is not set");
  process.exit(2);
}
const base = new URL(raw);
if (base.protocol !== "https:") {
  console.error("SMOKE_URL must be https");
  process.exit(2);
}

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};
const get = (path) =>
  fetch(new URL(path, base), {
    redirect: "manual",
    headers: { accept: "text/html,application/json" },
    signal: AbortSignal.timeout(15_000),
  });

const home = await get("/");
const html = await home.text();
check(home.status === 200, "/ is 200");
check(html.includes("StationKit"), "/ is the StationKit landing page");
check(home.headers.get("x-frame-options") === "DENY", "/ has X-Frame-Options");
check(home.headers.get("x-content-type-options") === "nosniff", "/ has nosniff");
check(home.headers.get("referrer-policy") === "no-referrer", "/ has Referrer-Policy");
check(
  (home.headers.get("x-robots-tag") ?? "").includes("noindex"),
  "/ is noindex",
);
const csp = home.headers.get("content-security-policy") ?? "";
check(
  /default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp),
  "/ has a strict CSP",
);
check(!/unsafe-(inline|eval)/.test(csp.split("script-src")[1] ?? ""), "script-src has no unsafe-inline");
check(
  (home.headers.get("cache-control") ?? "").includes("no-store"),
  "/ is no-store",
);

const api = await get("/api/stations");
const body = await api.text();
check(api.status === 401, "/api/stations is 401 when anonymous");
check(
  (api.headers.get("content-type") ?? "").includes("application/json"),
  "/api/stations answers JSON",
);
check(!/sk_(live|test)_|CONSOLE_WORKOS|WORKOS_/.test(body + html), "no secret name or value in responses");

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\npost-deploy smoke passed");
