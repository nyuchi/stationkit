import { handleSignIn } from "@workos/authkit-astro";
import { requireConfigured } from "./workos-guard";

export const prerender = false;
export const GET = requireConfigured(handleSignIn);
