import { createCallbackHandler } from "@workos/authkit-astro";

export const prerender = false;

// Exchanges the code, sets the session cookie, returns to the page asked for.
export const GET = createCallbackHandler();
