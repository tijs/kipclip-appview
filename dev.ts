#!/usr/bin/env -S deno run -A --watch=static/,routes/,lib/,frontend/,shared/
/**
 * Development server for kipclip.
 * Uses Fresh with hot reload for development.
 */

import { Builder } from "fresh/dev";

const builder = new Builder();

if (Deno.args.includes("build")) {
  // Production build
  await builder.build();
} else {
  // Development mode with hot reload
  await builder.listen(() => import("./main.ts"));
}
