// Production-bundle smoke: builds the app the way it is deployed and checks the
// guards that dev-mode tests cannot see. Plain Node, no test runner.
//
//   1. WorkOS mode: "/" is the landing page; /api/stations answers 401 JSON
//      WITH the security and no-store headers (AuthKit short-circuits it).
//   2. AUTH_MODE=mock in a production bundle answers 500 (the guard that
//      protects deploys outside Workers Builds).
import { spawn, spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";

const PORT = 4399;
const base = `http://localhost:${PORT}`;
const workos = {
  WORKOS_CLIENT_ID: "client_00000000000000000000000000",
  WORKOS_API_KEY: "sk_test_00000000000000000000000000",
  WORKOS_COOKIE_PASSWORD: "0123456789abcdef0123456789abcdef0123",
  WORKOS_REDIRECT_URI: `${base}/callback`,
};

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  if (!ok) failures.push(label);
};

// The build copies .dev.vars into dist/server, which is where `astro preview`
// (workerd) reads secrets from, so it must exist BEFORE the build.
function build(extra, vars = {}) {
  writeFileSync(".dev.vars", Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  const r = spawnSync("npx", ["astro", "build"], {
    env: { ...process.env, ...extra },
    stdio: ["ignore", "ignore", "inherit"],
  });
  rmSync(".dev.vars", { force: true });
  if (r.status !== 0) throw new Error("build failed");
}

async function withPreview(extra, run) {
  const child = spawn(
    process.execPath,
    ["node_modules/astro/bin/astro.mjs", "preview", "--ignore-lock", "--port", String(PORT)],
    { env: { ...process.env, ...(extra.env ?? {}) }, stdio: "ignore", detached: true },
  );
  try {
    for (let i = 0; i < 60; i++) {
      try {
        await fetch(`${base}/`, { redirect: "manual" });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    await run();
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

// 1. WorkOS mode, as deployed.
build({ AUTH_MODE: "workos" }, workos);
await withPreview({}, async () => {
  const home = await fetch(`${base}/`, { redirect: "manual" });
  check(home.status === 200, "workos: / is 200");
  check((await home.text()).includes("StationKit"), "workos: / is the landing page");
  const api = await fetch(`${base}/api/stations`, { redirect: "manual" });
  check(api.status === 401, "workos: /api/stations is 401 when anonymous");
  check(api.headers.get("cache-control")?.includes("no-store") === true, "workos: 401 is no-store");
  check(api.headers.get("x-frame-options") === "DENY", "workos: 401 has X-Frame-Options");
  check(api.headers.get("x-content-type-options") === "nosniff", "workos: 401 has nosniff");
  check(home.headers.get("content-security-policy")?.includes("frame-ancestors 'none'") === true, "workos: CSP frame-ancestors header");
  const csp = home.headers.get("content-security-policy") ?? "";
  check(/default-src 'self'/.test(csp) && /object-src 'none'/.test(csp), "workos: strict CSP (default-src self, object-src none)");
  check(/script-src 'self'/.test(csp) && !/script-src[^;]*unsafe-(inline|eval)/.test(csp), "workos: script-src is self plus hashes, no unsafe-inline");
});

// 2. Mock auth in a production bundle must refuse to serve.
build({ AUTH_MODE: "mock" });
await withPreview({ env: { AUTH_MODE: "mock" } }, async () => {
  const res = await fetch(`${base}/`, { redirect: "manual" });
  check(res.status === 500, "mock auth in a production bundle answers 500");
});

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("\nproduction smoke passed");
