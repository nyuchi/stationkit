import { failureCode, isRecord, mapIdentityFailure } from "./nyuchi-errors";
import { StationsApiError } from "./types";

/**
 * The console's own internal key: scopes `identity` and `stations`, minted and
 * set as Worker secrets by the owner. It identifies the console to the API;
 * it never identifies a person and it never leaves the server.
 */
export interface ConsoleCredentials {
  clientId: string;
  clientSecret: string;
}

export interface UpstreamRequest {
  method: "GET" | "POST";
  /** Path on the Nyuchi API, beginning `/v1/`. */
  path: string;
  headers: Record<string, string>;
  body?: string | undefined;
}

export interface UpstreamReply {
  status: number;
  /** The parsed JSON body, or null when there was none or it was not JSON. */
  body: unknown;
}

/** The one door to the network (nyuchi-client.ts). This module never opens its own. */
export type Send = (request: UpstreamRequest) => Promise<UpstreamReply>;

export const TOKEN_PATH = "/v1/auth/token";
export const ENSURE_PATH = "/v1/identity/persons/ensure";

const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
/** The only scope the console asks for: a person token that reaches /v1/stations and nothing else. */
export const STATIONS_SCOPE = "stations";

/** The API's longest exchanged token is 15 minutes. */
const MAX_LIFETIME_MS = 15 * 60_000;
/** Stop using a token a little before it expires, so a request in flight does not carry a dead one. */
const SKEW_MS = 30_000;
/** Bounds one isolate's memory; the oldest entry goes first. */
export const MAX_CACHED_TOKENS = 256;

interface Issued {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(bytes), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Trades a person's AuthKit access token for a short-lived API token (RFC
 * 8693, `POST /v1/auth/token`, `scope=stations`).
 *
 * - The token is kept in this isolate's memory only, keyed by a SHA-256 of the
 *   AuthKit token it came from, and dropped when it expires. It is never
 *   written to a cookie, a header the browser reads, or a log.
 * - Requests for one person that arrive together share one exchange.
 * - A person with no record at the API (`404 person_not_found`) is created once
 *   (`POST /v1/identity/persons/ensure`) and the exchange is tried once more.
 * - A failed exchange is never cached.
 */
export class TokenBroker {
  private readonly cache = new Map<string, Issued>();
  private readonly inflight = new Map<string, Promise<Issued>>();

  constructor(
    private readonly credentials: ConsoleCredentials,
    private readonly send: Send,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** A token for this person, and whether it came from the cache rather than a fresh exchange. */
  async token(
    subjectToken: string,
  ): Promise<{ token: string; cached: boolean }> {
    const key = await digest(subjectToken);
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now())
      return { token: hit.token, cached: true };
    this.cache.delete(key);

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.exchangeAndRemember(key, subjectToken);
      this.inflight.set(key, pending);
    }
    const issued = await pending;
    return { token: issued.token, cached: false };
  }

  /** Drop a token the API refused, so the next call exchanges again. */
  async forget(subjectToken: string): Promise<void> {
    this.cache.delete(await digest(subjectToken));
  }

  private async exchangeAndRemember(
    key: string,
    subjectToken: string,
  ): Promise<Issued> {
    try {
      let issued = await this.exchange(subjectToken);
      if (issued === null) {
        await this.ensurePerson(subjectToken);
        issued = await this.exchange(subjectToken);
        // Still no person after provisioning one: nothing more to try.
        if (issued === null) throw mapIdentityFailure(404, null);
      }
      this.remember(key, issued);
      return issued;
    } finally {
      this.inflight.delete(key);
    }
  }

  private remember(key: string, issued: Issued): void {
    if (issued.expiresAt <= this.now()) return;
    for (const [k, v] of this.cache)
      if (v.expiresAt <= this.now()) this.cache.delete(k);
    while (this.cache.size >= MAX_CACHED_TOKENS) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
    this.cache.set(key, issued);
  }

  private identityHeaders(): Record<string, string> {
    // The key pair travels in the headers as well as the form: the API then
    // counts the exchange against the console's key, not the Worker's shared
    // egress address (docs/AUTH.md, "The console backend").
    return {
      Accept: "application/json",
      "X-Client-Id": this.credentials.clientId,
      "X-Client-Secret": this.credentials.clientSecret,
    };
  }

  /** The issued token, or null when the API has no person for this user. */
  private async exchange(subjectToken: string): Promise<Issued | null> {
    const form = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      scope: STATIONS_SCOPE,
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
    });
    const reply = await this.send({
      method: "POST",
      path: TOKEN_PATH,
      headers: {
        ...this.identityHeaders(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (reply.status === 404 && failureCode(reply.body) === "person_not_found")
      return null;
    if (reply.status !== 200)
      throw mapIdentityFailure(reply.status, failureCode(reply.body));

    const body = reply.body;
    const token = isRecord(body) ? body.access_token : undefined;
    const scopes =
      isRecord(body) && typeof body.scope === "string"
        ? body.scope.split(/\s+/)
        : [];
    // A token that cannot reach /v1/stations is no use; do not keep it.
    if (typeof token !== "string" || !token || !scopes.includes(STATIONS_SCOPE))
      throw new StationsApiError(
        502,
        "The station service sent an unreadable answer",
      );
    const seconds =
      isRecord(body) && typeof body.expires_in === "number"
        ? body.expires_in
        : 0;
    const lifetime = Math.min(Math.max(seconds * 1000, 0), MAX_LIFETIME_MS);
    return { token, expiresAt: this.now() + lifetime - SKEW_MS };
  }

  private async ensurePerson(subjectToken: string): Promise<void> {
    const reply = await this.send({
      method: "POST",
      path: ENSURE_PATH,
      headers: {
        ...this.identityHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subject_token: subjectToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
      }),
    });
    if (reply.status !== 200 && reply.status !== 201)
      throw mapIdentityFailure(reply.status, failureCode(reply.body));
  }
}
