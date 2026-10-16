import { authkitMiddleware } from "@workos/authkit-astro";
import { configure } from "@workos/authkit-session";
import { defineMiddleware } from "astro:middleware";
import { env } from "cloudflare:workers";
import { createWorkosMiddleware } from "./workos-middleware-core";
import type { WorkosEnv } from "./workos-config";

// The package's own middleware: session validation and refresh, and the 401
// JSON for /api/stations when anonymous (a 302 to sign-in for an HTML request).
const authkit = authkitMiddleware({
  protectedRoutes: ["/api/stations"],
  signInPath: "/auth/signin",
});

export const onRequest = defineMiddleware(
  createWorkosMiddleware({
    getEnv: () => env as unknown as WorkosEnv,
    prod: import.meta.env.PROD,
    authkit: authkit as never,
    configure: configure as never,
  }) as never,
);
