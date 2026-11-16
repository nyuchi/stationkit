// Starts `astro dev` for the real-client Playwright run (playwright.nyuchi.config.ts).
//
// The dev runtime takes its settings from wrangler.jsonc `vars` ahead of the
// process environment, and `.dev.vars` ahead of both, so the settings that
// point the console at the fake Nyuchi API go there for the length of the run.
// A `.dev.vars` already on the machine is put back afterwards. The values are
// throwaway ones for the fake; the file is gitignored.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const FILE = ".dev.vars";
const port = process.env.E2E_APP_PORT ?? "4322";
const settings = {
  STATIONS_BACKEND: "nyuchi",
  NYUCHI_API_URL: process.env.E2E_API_URL,
  NYUCHI_CONSOLE_CLIENT_ID: process.env.E2E_CLIENT_ID,
  NYUCHI_CONSOLE_CLIENT_SECRET: process.env.E2E_CLIENT_SECRET,
};
for (const [name, value] of Object.entries(settings))
  if (!value) throw new Error(`${name} is not set for the e2e run`);

const previous = existsSync(FILE) ? readFileSync(FILE, "utf8") : null;
writeFileSync(
  FILE,
  Object.entries(settings)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n",
);

let restored = false;
const restore = () => {
  if (restored) return;
  restored = true;
  if (previous === null) rmSync(FILE, { force: true });
  else writeFileSync(FILE, previous);
};

const child = spawn(
  process.execPath,
  ["node_modules/astro/bin/astro.mjs", "dev", "--ignore-lock", "--port", port],
  { stdio: "inherit", env: { ...process.env, AUTH_MODE: "mock" } },
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
process.on("exit", restore);
child.on("exit", (code) => {
  restore();
  process.exit(code ?? 0);
});
