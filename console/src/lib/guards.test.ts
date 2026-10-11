import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const srcDir = join(root, "src");

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files(p, out);
    else out.push(p);
  }
  return out;
}

const all = files(srcDir);
const mine = all.filter(
  (f) =>
    !f.includes("/components/mzizi/") &&
    !f.includes("/styles/mzizi-globals.css") &&
    !f.endsWith(".test.ts"),
);
const text = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => relative(root, f);

describe("data egress (no database in the front end)", () => {
  const forbidden =
    /\b(mongodb|mongoose|pymongo|@cloudflare\/d1|drizzle|prisma|pg|postgres|supabase)\b/i;

  it("declares no database driver", () => {
    const pkg = JSON.parse(text(join(root, "package.json"))) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    for (const name of Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    }))
      expect(name).not.toMatch(forbidden);
  });
  it("imports no driver and binds no D1/KV/R2 for station records", () => {
    for (const f of mine.filter((x) => /\.(ts|astro)$/.test(x))) {
      const src = text(f);
      expect(src, rel(f)).not.toMatch(
        /from ["'](mongodb|mongoose|pg|postgres|@supabase\/[a-z-]+)["']/,
      );
      expect(src, rel(f)).not.toMatch(/\benv\.(DB|D1|STATIONS_DB)\b/);
    }
    const wrangler = text(join(root, "wrangler.jsonc"));
    expect(wrangler).not.toMatch(
      /d1_databases|kv_namespaces|r2_buckets|hyperdrive/,
    );
  });
  it("only the BFF client modules reach the network, and only the Nyuchi API", () => {
    const fetchers = mine
      .filter((f) => /\bfetch\b/.test(text(f)))
      .map(rel)
      .sort();
    expect(fetchers).toEqual(
      [
        "src/lib/config.ts",
        "src/lib/stations/api-client.ts",
        "src/lib/stations/nyuchi-client.ts",
      ].sort(),
    );
    // The browser never reaches the ingest or legacy station endpoints itself.
    for (const f of mine.filter((x) =>
      /\/(scripts|pages)\/|api-client/.test(rel(x)),
    )) {
      expect(text(f), rel(f)).not.toMatch(
        /\/stations\/(register|status|manual|ingest)\b/,
      );
    }
  });
  it("the browser code calls same-origin /api/stations only", () => {
    const calls = [
      ...text(join(srcDir, "lib/stations/api-client.ts")).matchAll(
        /["'`](\/?[a-z]+:\/\/[^"'`]+|\/api[^"'`]*)["'`]/g,
      ),
    ].map((m) => m[1]!);
    for (const c of calls) expect(c).toMatch(/^\/api\/stations/);
  });
});

describe("Mzizi styling rules", () => {
  it("has no hardcoded hex colours or inline styles outside the vendored Mzizi files", () => {
    for (const f of mine.filter((x) => /\.(ts|astro|css)$/.test(x))) {
      const src = text(f);
      expect(src, rel(f)).not.toMatch(
        /(?<![\w/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b(?![\w-])/,
      );
      expect(src, rel(f)).not.toMatch(/\brgba?\(/);
      expect(src, rel(f)).not.toMatch(/\sstyle\s*=/);
    }
  });
  it("renders every control through Mzizi components (no raw button/input in pages)", () => {
    for (const f of mine.filter(
      (x) => /\/(pages|components|layouts)\//.test(x) && x.endsWith(".astro"),
    )) {
      expect(text(f), rel(f)).not.toMatch(/<button\b/);
      expect(text(f), rel(f)).not.toMatch(/<input\b/);
    }
  });
  it("keeps the seven-mineral ribbon vertical, fixed to the left edge, in the base layout", () => {
    expect(text(join(srcDir, "layouts/Base.astro"))).toContain(
      "site-mineral-strip.astro",
    );
    const strip = text(
      join(srcDir, "components/mzizi/site-mineral-strip.astro"),
    );
    expect(strip).toMatch(/position:\s*fixed/);
    expect(strip).toMatch(/left:\s*0/);
    expect(strip).toMatch(/height:\s*100dvh/);
    expect(strip).toMatch(/flex-direction:\s*column/);
    expect(strip).not.toMatch(/flex-direction:\s*row/);
  });
  it("uses class-based dark mode and the Nyuchi brand", () => {
    const base = text(join(srcDir, "layouts/Base.astro"));
    expect(base).toContain('data-brand="nyuchi"');
    expect(base).not.toContain('data-brand="weather"');
    expect(base).toContain('src="/theme-init.js"');
    const init = text(join(root, "public/theme-init.js"));
    expect(init).toMatch(/classList\s*\.toggle\(\s*"dark"/);
    expect(init).toContain("prefers-color-scheme");
  });
});

describe("accessibility and privacy contracts", () => {
  it("has a skip link, noindex, and landmarks on both entry states", () => {
    const base = text(join(srcDir, "layouts/Base.astro"));
    expect(base).toContain('href="#main"');
    expect(base).toContain("noindex");
    const landing = text(join(srcDir, "components/Landing.astro"));
    expect(landing).toContain('role="banner"');
    expect(landing).toContain('id="main"');
    expect(text(join(srcDir, "components/SiteFooter.astro"))).toContain(
      'role="contentinfo"',
    );
  });
  it("renders dynamic text with textContent, never innerHTML", () => {
    expect(text(join(srcDir, "scripts/console.ts"))).not.toMatch(
      /innerHTML|insertAdjacentHTML|outerHTML/,
    );
  });
  it("never logs request data, keys or tokens", () => {
    for (const f of mine.filter((x) => /\.(ts|astro)$/.test(x)))
      expect(text(f), rel(f)).not.toMatch(
        /console\.(log|info|debug|warn|error)\(/,
      );
  });
  it("respects reduced motion (no custom animation defined locally)", () => {
    const css = text(join(srcDir, "styles/global.css"));
    expect(css).not.toMatch(/@keyframes|animation:/);
  });
});

describe("a Nyuchi product that talks to Nyuchi only", () => {
  const configFiles = [
    "wrangler.jsonc",
    "astro.config.mjs",
    "package.json",
    ".env.example",
    "public/theme-init.js",
    "integrations/mock-auth.mjs",
    "integrations/security-headers.mjs",
    "integrations/workos-auth.mjs",
  ].map((f) => join(root, f));
  const scanned = [
    ...mine.filter((f) => /\.(ts|astro|css)$/.test(f)),
    ...configFiles,
  ];

  it("never references a mukoko.com host or an /api/py route", () => {
    for (const f of scanned) {
      expect(text(f), rel(f)).not.toMatch(/mukoko\.com/i);
      expect(text(f), rel(f)).not.toMatch(/\/api\/py/);
    }
  });

  it("is branded StationKit by Nyuchi, not Mukoko", () => {
    for (const f of [
      ...mine.filter((x) => /\.(ts|astro)$/.test(x)),
      ...configFiles,
    ]) {
      expect(text(f), rel(f)).not.toMatch(/mukoko/i);
    }
    const links = text(join(srcDir, "lib/links.ts"));
    expect(links).toContain("hi@nyuchi.com");
    expect(links).toContain("Rima uchiziva. Farm knowing.");
    expect(text(join(srcDir, "components/Landing.astro"))).toContain(
      "PRODUCT_NAME",
    );
  });

  it("points hardware at the confirmed Nyuchi ingest host and the API at api.nyuchi.com", () => {
    const ingest = text(join(srcDir, "lib/ingest.ts"));
    expect(ingest).toContain('"weather-ingest.nyuchi.com"');
    expect(ingest).toContain('"/stations/ingest"');
    expect(text(join(srcDir, "lib/config.ts"))).toContain(
      '"https://api.nyuchi.com"',
    );
  });

  it("every absolute URL in the app is on a Nyuchi, Bundu or font host", () => {
    const allowed =
      /^https?:\/\/([a-z0-9-]+\.)*(nyuchi\.com|bundu\.org|github\.com|example\.test|localhost)(?=[:/"'\s]|$)/i;
    for (const f of scanned.filter((x) => !x.endsWith("package.json"))) {
      for (const m of text(f).matchAll(/https?:\/\/[^\s"'`)<>]+/g)) {
        expect(m[0], rel(f)).toMatch(allowed);
      }
    }
  });

  it("serves a strict CSP and refuses mock backends and auth in production", () => {
    const config = text(join(root, "astro.config.mjs"));
    expect(config).toContain("default-src 'self'");
    expect(config).toContain("object-src 'none'");
    expect(text(join(srcDir, "lib/config.ts"))).toContain(
      "not allowed in a production runtime",
    );
    expect(text(join(srcDir, "auth/mock-middleware.ts"))).toContain(
      "import.meta.env.PROD",
    );
    expect(text(join(srcDir, "pages/auth/signout.ts"))).not.toMatch(
      /export const GET/,
    );
  });
});

describe("WorkOS credentials", () => {
  const wrangler = text(join(root, "wrangler.jsonc"));

  it("takes the API key from the Secrets Store binding, with a marked placeholder store id", () => {
    expect(wrangler).toMatch(/"secrets_store_secrets"/);
    expect(wrangler).toMatch(/"binding":\s*"CONSOLE_WORKOS_API_KEY"/);
    expect(wrangler).toMatch(/"secret_name":\s*"CONSOLE_WORKOS_API_KEY"/);
    expect(wrangler).toMatch(/"store_id":\s*"REPLACE_WITH_SECRETS_STORE_ID"/);
    expect(wrangler).toContain("OWNER ACTION");
  });

  it("keeps the client id public and the cookie password out of the repo", () => {
    expect(wrangler).toContain('"WORKOS_CLIENT_ID": "client_01KQBBSMQTSMTBN7HEC9KQBJC0"');
    expect(wrangler).toContain('"WORKOS_REDIRECT_URI": "https://weatherstations.nyuchi.com/callback"');
    const code = wrangler.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/WORKOS_COOKIE_PASSWORD|(?<!CONSOLE_)WORKOS_API_KEY"/);
  });

  it("commits no secret value anywhere", () => {
    for (const f of [
      ...mine.filter((x) => /\.(ts|astro|css)$/.test(x)),
      join(root, "README.md"),
      join(root, "wrangler.jsonc"),
    ]) {
      expect(text(f), rel(f)).not.toMatch(/\bsk_(live|test)_[A-Za-z0-9]{8,}/);
    }
  });

  it("configures AuthKit at runtime from the Worker env, not from astro:env", () => {
    const mw = text(join(srcDir, "auth/workos-middleware.ts"));
    expect(mw).toContain('from "cloudflare:workers"');
    expect(mw).toContain("resolveWorkosConfig");
    expect(mw).not.toContain("astro:env");
    expect(text(join(srcDir, "auth/workos-config.ts"))).toContain(".get()");
    expect(text(join(root, "astro.config.mjs"))).not.toContain('from "@workos/authkit-astro"');
  });

  it("answers JSON 500 and fails closed on bad config, and never logs", () => {
    const mw = text(join(srcDir, "auth/workos-middleware.ts"));
    expect(mw).toContain("status: 500");
    expect(mw).toContain("application/json");
    expect(mw).toMatch(/auth:\s*unknown|user: null/);
    for (const f of ["workos-middleware.ts", "workos-config.ts"])
      expect(text(join(srcDir, "auth", f)), f).not.toMatch(/console\.|JSON\.stringify\(\s*env/);
  });
});
