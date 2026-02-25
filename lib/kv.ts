/**
 * Deno KV singleton for background job processing.
 * Supports injection for testing via setKv().
 */

let kv: Deno.Kv | null = null;

export async function getKv(): Promise<Deno.Kv> {
  if (!kv) kv = await Deno.openKv();
  return kv;
}

export function setKv(mock: Deno.Kv): void {
  kv = mock;
}
