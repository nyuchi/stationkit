/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    auth: import("./auth/session").AuthLike;
    /** Set by the WorkOS middleware: this request resolved a valid config. */
    workosConfigOk?: boolean;
  }
}

// Provided by the Workers runtime (and the Astro Cloudflare adapter at build).
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
