import { defineMiddleware } from "astro:middleware";
import { mockUser, parseMockCookie } from "./session";

/** Cookie session standing in for WorkOS in development and tests. Never in production. */
export const onRequest = defineMiddleware(async (context, next) => {
  if (import.meta.env.PROD) {
    return new Response(
      "Mock authentication is disabled in production builds.",
      { status: 500 },
    );
  }
  const slug = parseMockCookie(context.request.headers.get("cookie"));
  const user = slug ? mockUser(slug) : null;
  (context.locals as unknown as { auth: unknown }).auth = {
    user,
    // One per person, as a real AuthKit token is, so the real client can be
    // tried against a fake Nyuchi API that tells people apart by it.
    accessToken: slug ? `mock-access-token.${slug}` : undefined,
  };
  return next();
});
