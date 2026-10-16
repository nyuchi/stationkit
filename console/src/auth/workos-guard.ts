import type { APIContext, APIRoute } from "astro";

/**
 * The injected sign-in, callback and logout routes run only when THIS request
 * resolved a valid WorkOS configuration (the middleware sets
 * `locals.workosConfigOk`). After a transient config failure the previous,
 * still-configured AuthKit instance in the isolate therefore cannot serve them.
 */
export function requireConfigured(handler: APIRoute): APIRoute {
  return (context: APIContext) => {
    if ((context.locals as { workosConfigOk?: boolean }).workosConfigOk !== true)
      return new Response("The console is not configured correctly.", {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    return handler(context);
  };
}
