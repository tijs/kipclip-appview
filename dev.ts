/** Development entrypoint; frontend watcher is orchestrated by deno task dev. */
import { startServer } from "./runtime/deno/server.ts";
if (import.meta.main) await startServer();
