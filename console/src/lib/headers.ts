/** Response headers as data, applied by src/lib/headers-middleware.ts to every response. */

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Permissions-Policy": "geolocation=(self), camera=(), microphone=()",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/**
 * Astro emits the script/style CSP itself (astro.config.mjs). frame-ancestors
 * is appended to whatever policy is already on the response, never replacing
 * it.
 */
export const FRAME_ANCESTORS = "frame-ancestors 'none'";

export function withFrameAncestors(existing: string | null): string {
  if (!existing) return FRAME_ANCESTORS;
  return /(^|;)\s*frame-ancestors\b/i.test(existing)
    ? existing
    : `${existing.replace(/;\s*$/, "")}; ${FRAME_ANCESTORS}`;
}

/** The BFF carries one-time ingest keys: nothing may cache them. */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
};

export function applyHeaders(response: Response, pathname: string): Response {
  const noStore =
    pathname.startsWith("/api/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/callback") ||
    pathname.startsWith("/_authkit") ||
    pathname === "/";
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);
  headers.set(
    "Content-Security-Policy",
    withFrameAncestors(headers.get("Content-Security-Policy")),
  );
  if (noStore)
    for (const [k, v] of Object.entries(NO_STORE_HEADERS)) headers.set(k, v);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
