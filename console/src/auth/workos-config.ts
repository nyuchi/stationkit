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

/** How long a Secrets Store read is reused (a rotation takes effect within it). */
export const KEY_CACHE_TTL_MS = 120_000;

interface KeyCache {
  value: string;
  at: number;
}
let keyCache: KeyCache | null = null;

/** Test hook: forget the cached key. */
export function resetKeyCache(): void {
  keyCache = null;
}

export interface ResolveOptions {
  /** A production runtime: a plain string key is refused (dev only). */
  prod?: boolean;
  now?: () => number;
}

async function readApiKey(
  binding: unknown,
  opts: ResolveOptions,
): Promise<string | null> {
  // A plain string is a local `.dev.vars` convenience. In production only the
  // Secrets Store binding may supply the key, so a stray Worker secret of the
  // same name can never stand in for it.
  if (typeof binding === "string") return opts.prod ? null : binding || null;
  if (!isBinding(binding)) {
    keyCache = null;
    return null;
  }
  const now = (opts.now ?? Date.now)();
  if (keyCache && now - keyCache.at < KEY_CACHE_TTL_MS) return keyCache.value;
  try {
    const value = (await binding.get()) || null;
    keyCache = value ? { value, at: now } : null;
    return value;
  } catch {
    // A failed Secrets Store read is "missing" and drops the cache, never an
    // exception that could carry detail upstream.
    keyCache = null;
    return null;
  }
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Validates and assembles the AuthKit config. Fails closed: any gap is `ok: false`. */
export async function resolveWorkosConfig(
  env: WorkosEnv,
  opts: ResolveOptions = {},
): Promise<WorkosConfigResult> {
  const clientId = text(env.WORKOS_CLIENT_ID);
  const redirectUri = text(env.WORKOS_REDIRECT_URI);
  const cookiePassword =
    typeof env.WORKOS_COOKIE_PASSWORD === "string"
      ? env.WORKOS_COOKIE_PASSWORD
      : null;
  const apiKey = await readApiKey(env.CONSOLE_WORKOS_API_KEY, opts);

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

/**
 * A change-detector so AuthKit is reconfigured only when a value changes. It is
 * a SHA-256 digest, so the key and the cookie password are never kept as text
 * just to compare them.
 */
export async function fingerprint(c: WorkosConfig): Promise<string> {
  const data = new TextEncoder().encode(
    JSON.stringify([c.clientId, c.apiKey, c.redirectUri, c.cookiePassword]),
  );
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
