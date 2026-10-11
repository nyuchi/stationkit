import type { APIRoute } from "astro";

export const prerender = false;

/**
 * The account menu signs out with a POST form, so a link on another site
 * cannot trigger it. The AuthKit logout route (/auth/logout) only takes GET,
 * so this hands over to it; the mock session has the same route. That
 * upstream GET route stays reachable by URL, which is a known limit of the
 * integration.
 */
export const POST: APIRoute = ({ redirect }) => redirect("/auth/logout", 303);
