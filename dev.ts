#!/usr/bin/env -S deno run -A --watch=main.ts,lib/,frontend/,shared/
/**
 * Development server for kipclip.
 * Uses Fresh with hot reload for development.
 */

import { Builder } from "jsr:@fresh/core@^2.2.0/dev";
import { app } from "./main.ts";

const builder = new Builder();

if (Deno.args.includes("build")) {
  // Production build
  await builder.build(app);
} else {
  // Development mode with hot reload
  builder.listen(app);
}
