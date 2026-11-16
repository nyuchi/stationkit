import { createCallbackHandler } from "@workos/authkit-astro";
import { requireConfigured } from "./workos-guard";

export const prerender = false;

/**
 * Exchanges the code, sets the session cookie, returns to the page asked for.
 * On failure the answer is a FIXED message: the default reflects WorkOS's
 * `error`, `error_description` and the exception message back to the browser.
 */
export const FAILED_BODY =
  "Sign-in did not complete. Go back to the console and try again.";

export const GET = requireConfigured(
  createCallbackHandler({
    onError: () =>
      new Response(FAILED_BODY, {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
  }),
);
