import { resolveDid } from "./plc-resolver.ts";
import { assertSafePdsUrl } from "./pds-public.ts";

/** Never use a cached host as authority: migrated PDSs can still serve old data. */
export async function currentPdsUrl(did: string): Promise<string> {
  const resolved = await resolveDid(did, AbortSignal.timeout(15_000));
  if (!resolved) throw new Error(`Could not resolve current PDS for ${did}`);
  assertSafePdsUrl(resolved.pdsUrl);
  return resolved.pdsUrl;
}
