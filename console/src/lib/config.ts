import { DEFAULT_INGEST_HOST, HOST_RE } from "./ingest";
import type { StationsClient } from "./stations/types";
import { MockStationsClient } from "./stations/mock-client";
import { NyuchiStationsClient } from "./stations/nyuchi-client";
import type { ConsoleCredentials } from "./stations/nyuchi-token";

export interface ConsoleConfig {
  backend: "mock" | "nyuchi";
  nyuchiApiUrl: string;
  ingestHost: string;
  /**
   * False when the Nyuchi backend is selected but the console has not been
   * given its key: stations then answer "not live yet".
   */
  live: boolean;
}

export { DEFAULT_INGEST_HOST, INGEST_PATH } from "./ingest";

/** Nyuchi's API: the only host this app talks to. */
export const DEFAULT_NYUCHI_API_URL = "https://api.nyuchi.com";

export interface RawConfig {
  STATIONS_BACKEND?: string | undefined;
  NYUCHI_API_URL?: string | undefined;
  NYUCHI_INGEST_HOST?: string | undefined;
  /** Worker secrets: the console's own internal key (scopes identity and stations). */
  NYUCHI_CONSOLE_CLIENT_ID?: string | undefined;
  NYUCHI_CONSOLE_CLIENT_SECRET?: string | undefined;
}

/** One token: no whitespace or control characters, so it cannot smuggle a header. */
const CREDENTIAL_RE = /^[\x21-\x7e]{1,256}$/;

/**
 * The console's key, from the Worker secrets. Both or neither: a half-set
 * pair is a mistake and fails loudly rather than leaving the console quietly
 * "not live". Messages name the settings, never a value.
 */
export function resolveCredentials(raw: RawConfig): ConsoleCredentials | null {
  const clientId = raw.NYUCHI_CONSOLE_CLIENT_ID?.trim();
  const clientSecret = raw.NYUCHI_CONSOLE_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret)
    throw new Error(
      "NYUCHI_CONSOLE_CLIENT_ID and NYUCHI_CONSOLE_CLIENT_SECRET must be set together",
    );
  if (!CREDENTIAL_RE.test(clientId) || !CREDENTIAL_RE.test(clientSecret))
    throw new Error(
      "NYUCHI_CONSOLE_CLIENT_ID and NYUCHI_CONSOLE_CLIENT_SECRET must each be a single token",
    );
  return { clientId, clientSecret };
}

export interface ConfigContext {
  /** True in a production runtime (`import.meta.env.PROD`). */
  prod: boolean;
}

/**
 * Validates the environment. A bad value fails loudly rather than silently
 * mocking, and the mock backend is refused outright in production: it would
 * hand real owners credentials the platform never issued.
 */
export function resolveConfig(
  raw: RawConfig,
  ctx: ConfigContext = { prod: false },
): ConsoleConfig {
  const requested =
    raw.STATIONS_BACKEND?.trim() || (ctx.prod ? "nyuchi" : "mock");
  if (requested !== "mock" && requested !== "nyuchi")
    throw new Error(
      `STATIONS_BACKEND must be "mock" or "nyuchi", got "${requested}"`,
    );
  if (requested === "mock" && ctx.prod)
    throw new Error(
      "STATIONS_BACKEND=mock is not allowed in a production runtime",
    );

  let parsed: URL;
  try {
    parsed = new URL(raw.NYUCHI_API_URL?.trim() || DEFAULT_NYUCHI_API_URL);
  } catch {
    throw new Error("NYUCHI_API_URL must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost")
    throw new Error("NYUCHI_API_URL must use https");
  const nyuchiApiUrl = parsed.origin + parsed.pathname.replace(/\/+$/, "");

  const ingestHost = raw.NYUCHI_INGEST_HOST?.trim() || DEFAULT_INGEST_HOST;
  if (!HOST_RE.test(ingestHost))
    throw new Error("NYUCHI_INGEST_HOST must be a host name");

  const live = requested === "mock" || resolveCredentials(raw) !== null;
  return { backend: requested, nyuchiApiUrl, ingestHost, live };
}

let mockSingleton: MockStationsClient | null = null;
let nyuchiSingleton: {
  signature: string;
  client: NyuchiStationsClient;
} | null = null;

export interface ClientOptions {
  fetchImpl?: typeof fetch | undefined;
  seedDemo?: boolean | undefined;
  /** The console's key; the Nyuchi backend answers "not live yet" without it. */
  credentials?: ConsoleCredentials | null | undefined;
}

/**
 * The one place that picks a client. The mock is shared so state survives
 * requests. So is the Nyuchi client, so the tokens it has exchanged for
 * people stay in this isolate's memory between requests instead of being
 * exchanged again on every call; a changed URL or key makes a new one.
 */
export function createStationsClient(
  config: ConsoleConfig,
  options: ClientOptions = {},
): StationsClient {
  if (config.backend === "nyuchi") {
    const credentials = options.credentials ?? null;
    if (options.fetchImpl)
      return new NyuchiStationsClient(config.nyuchiApiUrl, {
        credentials,
        fetchImpl: options.fetchImpl,
      });
    const signature = [
      config.nyuchiApiUrl,
      credentials?.clientId ?? "",
      credentials?.clientSecret ?? "",
    ].join("\n");
    if (nyuchiSingleton?.signature !== signature)
      nyuchiSingleton = {
        signature,
        client: new NyuchiStationsClient(config.nyuchiApiUrl, { credentials }),
      };
    return nyuchiSingleton.client;
  }
  mockSingleton ??= new MockStationsClient({
    seedDemo: options.seedDemo ?? false,
  });
  return mockSingleton;
}
