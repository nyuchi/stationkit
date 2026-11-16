import type { APIRoute } from "astro";

export const prerender = false;

/**
 * The account menu signs out with a POST form. This forwards to /auth/logout
 * with a 307, which keeps the method, so the logout route is only ever reached
 * by POST (the mock session has the same route).
 */
export const POST: APIRoute = ({ redirect }) => redirect("/auth/logout", 307);
