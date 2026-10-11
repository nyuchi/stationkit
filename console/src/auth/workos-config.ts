/**
 * WorkOS configuration for @workos/authkit-astro, resolved at RUNTIME from the
 * Worker environment (never inlined at build time).
 *
 * - WORKOS_API_KEY comes from the Cloudflare Secrets Store: the binding
 *   CONSOLE_WORKOS_API_KEY (an object with an async `get()`), secret name
 *   CONSOLE_WORKOS_API_KEY. Locally it may be a plain string in `.dev.vars`.
 * - WORKOS_COOKIE_PASSWORD is a separate Worker secret (`wrangler secret put`).
 * - WORKOS_CLIENT_ID and WORKOS_REDIRECT_URI are public plain vars.
 *
 * Nothing here logs, and error values name the missing setting only.
 */

export interface SecretsStoreBinding {
  get(): Promise<string | null>;
}

export interface WorkosEnv {
  WORKOS_CLIENT_ID?: unknown;
  WORKOS_REDIRECT_URI?: unknown;
  WORKOS_COOKIE_PASSWORD?: unknown;
  CONSOLE_WORKOS_API_KEY?: unknown;
}

export interface WorkosConfig {
  clientId: string;
  apiKey: string;
  redirectUri: string;
  cookiePassword: string;
}

export type WorkosConfigResult =
  | { ok: true; config: WorkosConfig }
  | { ok: false; problems: string[] };

export const API_KEY_BINDING = "CONSOLE_WORKOS_API_KEY";
export const MIN_COOKIE_PASSWORD_LENGTH = 32;

function isBinding(v: unknown): v is SecretsStoreBinding {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { get?: unknown }).get === "function"
  );
}

async function readApiKey(binding: unknown): Promise<string | null> {
  if (typeof binding === "string") return binding || null;
  if (!isBinding(binding)) return null;
  try {
    return (await binding.get()) || null;
  } catch {
    // A failed Secrets Store read is "missing", never an exception that could
    // carry detail upstream.
    return null;
  }
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Validates and assembles the AuthKit config. Fails closed: any gap is `ok: false`. */
export async function resolveWorkosConfig(
  env: WorkosEnv,
): Promise<WorkosConfigResult> {
  const clientId = text(env.WORKOS_CLIENT_ID);
  const redirectUri = text(env.WORKOS_REDIRECT_URI);
  const cookiePassword =
    typeof env.WORKOS_COOKIE_PASSWORD === "string"
      ? env.WORKOS_COOKIE_PASSWORD
      : null;
  const apiKey = await readApiKey(env.CONSOLE_WORKOS_API_KEY);

  const problems: string[] = [];
  if (!clientId) problems.push("WORKOS_CLIENT_ID");
  if (!redirectUri) problems.push("WORKOS_REDIRECT_URI");
  if (!apiKey) problems.push(API_KEY_BINDING);
  if (!cookiePassword) problems.push("WORKOS_COOKIE_PASSWORD");
  else if (cookiePassword.length < MIN_COOKIE_PASSWORD_LENGTH)
    problems.push(
      `WORKOS_COOKIE_PASSWORD (shorter than ${MIN_COOKIE_PASSWORD_LENGTH} characters)`,
    );
  if (redirectUri) {
    try {
      const u = new URL(redirectUri);
      if (u.protocol !== "https:" && u.hostname !== "localhost")
        problems.push("WORKOS_REDIRECT_URI (must be https)");
    } catch {
      problems.push("WORKOS_REDIRECT_URI (not a URL)");
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      clientId: clientId!,
      apiKey: apiKey!,
      redirectUri: redirectUri!,
      cookiePassword: cookiePassword!,
    },
  };
}

/** A stable change-detector so AuthKit is reconfigured only when a value changes. */
export function fingerprint(c: WorkosConfig): string {
  return JSON.stringify([c.clientId, c.apiKey, c.redirectUri, c.cookiePassword]);
}
