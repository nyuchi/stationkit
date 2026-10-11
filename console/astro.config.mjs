import cloudflare from "@astrojs/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import authkit from "@workos/authkit-astro";
import { defineConfig, envField } from "astro/config";

import { mockAuth } from "./integrations/mock-auth.mjs";
import { securityHeaders } from "./integrations/security-headers.mjs";

// AUTH_MODE=mock swaps WorkOS for a cookie session so the UI and the
// Playwright smoke run without credentials. It is refused on Workers Builds
// and in any production runtime (see src/auth/mock-middleware.ts).
const authMode = process.env.AUTH_MODE === "mock" ? "mock" : "workos";

const auth =
  authMode === "mock"
    ? mockAuth()
    : authkit({
        // The BFF answers 401 JSON to fetch(); pages decide for themselves
        // (anonymous visitors get the landing page at "/").
        protectedRoutes: ["/api/stations"],
        signInPath: "/auth/signin",
        loginPath: "/auth/signin",
        logoutPath: "/auth/logout",
        callbackPath: "/callback",
        afterSignOutUrl: "/",
        hydrateClient: false,
      });

export default defineConfig({
  output: "server",
  adapter: cloudflare({ imageService: "passthrough" }),
  session: false,
  integrations: [securityHeaders(), auth],
  vite: { plugins: [tailwindcss()] },
  security: {
    checkOrigin: true,
    // Ingest keys are shown on this page and kept in localStorage, so a strict
    // CSP is the main defence against injected script. Astro adds the hashes
    // for its own inline scripts and styles.
    csp: {
      directives: [
        "default-src 'self'",
        "font-src https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ],
      scriptDirective: { resources: ["'self'"] },
      styleDirective: { resources: ["'self'", "https://fonts.googleapis.com"] },
    },
  },
  env: {
    // All runtime (secret) values, so a deploy can change them without a
    // rebuild; none of them is a secret, they are just not inlined.
    schema: {
      STATIONS_BACKEND: envField.enum({
        context: "server",
        access: "secret",
        values: ["mock", "nyuchi"],
        optional: true,
      }),
      NYUCHI_API_URL: envField.string({ context: "server", access: "secret", optional: true }),
      NYUCHI_INGEST_HOST: envField.string({ context: "server", access: "secret", optional: true }),
    },
  },
});
