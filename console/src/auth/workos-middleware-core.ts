import {
  fingerprint,
  resolveWorkosConfig,
  type WorkosConfig,
  type WorkosEnv,
} from "./workos-config";

/** The slice of Astro's middleware context this needs. */
export interface MiddlewareContext {
  locals: Record<string, unknown>;
  url: URL;
  isPrerendered?: boolean;
}
type Next = () => Promise<Response>;

export interface WorkosMiddlewareDeps {
  getEnv(): WorkosEnv;
  /** A production runtime (refuses a plain-string API key). */
  prod: boolean;
  /** The package's own `authkitMiddleware(...)`. */
  authkit(context: never, next: never): Promise<unknown>;
  /** `configure` from @workos/authkit-session (the shared provider). */
  configure(config: Record<string, unknown>, source: () => undefined): void;
}

/** A signed-out `locals.auth` with the full shape, for requests with no valid config. */
export function anonymousAuth() {
  const fail = (): never => {
    throw new Error("AuthKit is not configured for this request");
  };
  return {
    user: null,
    claims: null,
    organizationId: null,
    role: null,
    roles: [],
    permissions: [],
    entitlements: [],
    featureFlags: [],
    impersonator: null,
    has: () => false,
    redirectToSignIn: fail,
  };
}

/** What AuthKit is configured with: the four settings plus hardened cookie options. */
export function authConfig(c: WorkosConfig): Record<string, unknown> {
  const https = c.redirectUri.startsWith("https://");
  return {
    clientId: c.clientId,
    apiKey: c.apiKey,
    redirectUri: c.redirectUri,
    cookiePassword: c.cookiePassword,
    // `__Host-` needs Secure, so only over https (local http dev keeps the default).
    ...(https ? { cookieName: "__Host-wos-session" } : {}),
    // A week, not the library's 400 days; the tokens inside are shorter-lived.
    cookieMaxAge: 60 * 60 * 24 * 7,
  };
}

const NOT_CONFIGURED = {
  error: "The console is not configured correctly. Try again later.",
};

/**
 * Resolves the WorkOS settings from the Worker environment on every request
 * (API key from the Secrets Store binding, cached for a short time), configures
 * AuthKit when a value changed, then runs AuthKit.
 *
 * - The environment source is REPLACED (`() => undefined`): the library reads
 *   process.env first, so a leftover plain secret named WORKOS_API_KEY (or the
 *   other three) could otherwise beat the Secrets Store value.
 * - Fails closed. With bad config the BFF answers JSON 500, every other request
 *   continues with no session, and `locals.workosConfigOk` is false so the
 *   injected sign-in, callback and logout routes refuse too (the previous,
 *   still-configured AuthKit instance of the isolate cannot serve them).
 * - Never logs; answers name no value.
 */
export function createWorkosMiddleware(deps: WorkosMiddlewareDeps) {
  let configured = "";

  return async (context: MiddlewareContext, next: Next): Promise<Response> => {
    context.locals.workosConfigOk = false;

    // Prerendered pages have no session and need no secret read.
    if (context.isPrerendered) {
      context.locals.auth = anonymousAuth();
      return next();
    }

    const result = await resolveWorkosConfig(deps.getEnv(), {
      prod: deps.prod,
    });
    if (!result.ok) {
      if (context.url.pathname.startsWith("/api/"))
        return new Response(JSON.stringify(NOT_CONFIGURED), {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      context.locals.auth = anonymousAuth();
      return next();
    }

    const fp = await fingerprint(result.config);
    if (fp !== configured) {
      deps.configure(authConfig(result.config), () => undefined);
      configured = fp;
    }
    context.locals.workosConfigOk = true;
    return (await deps.authkit(context as never, next as never)) as Response;
  };
}
