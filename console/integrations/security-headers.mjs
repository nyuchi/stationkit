import { fileURLToPath } from "node:url";

const at = (rel) => fileURLToPath(new URL(rel, import.meta.url));

/**
 * Registers the response-header middleware as a `pre` middleware. It must be
 * listed BEFORE the auth integration: AuthKit answers anonymous /api calls
 * and redirects itself, and a middleware registered later would never see
 * those responses.
 */
export function securityHeaders() {
  return {
    name: "stationkit-console-security-headers",
    hooks: {
      "astro:config:setup": ({ addMiddleware }) => {
        addMiddleware({
          entrypoint: at("../src/lib/headers-middleware.ts"),
          order: "pre",
        });
      },
    },
  };
}
