import { fileURLToPath } from "node:url";

const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/**
 * WorkOS AuthKit wiring, owned here instead of by the package's own
 * `authkit()` integration. That integration's middleware reads its settings
 * from build-time `astro:env` strings, so it cannot take an API key from the
 * Cloudflare Secrets Store (a binding with an async `get()`). This one injects
 * the same routes and adds a middleware that resolves the settings at runtime
 * (src/auth/workos-config.ts) and then runs the package's own
 * `authkitMiddleware`. List it AFTER securityHeaders().
 */
export function workosAuth() {
  return {
    name: "stationkit-console-workos-auth",
    hooks: {
      "astro:config:setup": ({ addMiddleware, injectRoute }) => {
        addMiddleware({
          entrypoint: at("../src/auth/workos-middleware.ts"),
          order: "pre",
        });
        injectRoute({
          pattern: "/auth/signin",
          entrypoint: at("../src/auth/workos-signin.ts"),
          prerender: false,
        });
        injectRoute({
          pattern: "/callback",
          entrypoint: at("../src/auth/workos-callback.ts"),
          prerender: false,
        });
        injectRoute({
          pattern: "/auth/logout",
          entrypoint: at("../src/auth/workos-logout.ts"),
          prerender: false,
        });
      },
    },
  };
}
