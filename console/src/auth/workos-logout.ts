import { createSignOutHandler } from "@workos/authkit-astro";
import { requireConfigured } from "./workos-guard";

export const prerender = false;

/**
 * POST only, so Astro's origin check protects it and a link on another site
 * cannot sign anyone out. /auth/signout (the account menu's form target)
 * forwards here.
 */
export const POST = requireConfigured(createSignOutHandler());
