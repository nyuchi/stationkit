import { authkitMiddleware, configureAuthKit } from "@workos/authkit-astro";
import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import {
  fingerprint,
  resolveWorkosConfig,
  type WorkosEnv,
} from "./workos-config";

let configured = "";

// The package's own middleware: session validation and refresh, and the 401
// JSON for /api/stations when anonymous. Its settings are supplied below.
const authkit = authkitMiddleware({
  protectedRoutes: ["/api/stations"],
  signInPath: "/auth/signin",
});

/**
 * Resolves the WorkOS settings from the Worker environment on every request
 * (API key from the Secrets Store binding), configures AuthKit when a value
 * changed, then runs AuthKit.
 *
 * Fails closed. With bad config the BFF answers JSON 500, and every other
 * request continues WITHOUT a session (the visitor is signed out and the
 * sign-in routes error), so a broken deploy can never grant access. It never
 * logs, and the answer names no value.
 */
export const onRequest = defineMiddleware(async (context, next) => {
  const result = await resolveWorkosConfig(env as unknown as WorkosEnv);
  if (!result.ok) {
    if (context.url.pathname.startsWith("/api/"))
      return new Response(
        JSON.stringify({
          error: "The console is not configured correctly. Try again later.",
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        },
      );
    (context.locals as unknown as { auth: unknown }).auth = { user: null };
    return next();
  }
  const fp = fingerprint(result.config);
  if (fp !== configured) {
    configureAuthKit(result.config);
    configured = fp;
  }
  // authkitMiddleware (no custom handler) always returns a Response.
  return (await authkit(context, next)) as Response;
});
