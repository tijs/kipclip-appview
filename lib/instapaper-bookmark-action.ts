import { db } from "./db.ts";
import { decrypt } from "./encryption.ts";
import { sendToInstapaper } from "./instapaper.ts";
import { resolveDid } from "./plc-resolver.ts";
import { getAuthoritativeReadingListTag } from "./preferences.ts";
import type { BookmarkSavedEvent } from "./events.ts";

/** These preferences are public PDS records. Instapaper credentials alone are
 * sufficient for delivery; no browser session or PDS write authority is needed. */
async function readReadingListTag(
  did: string,
  bookmark: BookmarkSavedEvent["bookmark"],
): Promise<string | null | false> {
  const resolved = await resolveDid(did, AbortSignal.timeout(10_000));
  if (!resolved) return null;
  // A delayed TAP echo can recreate a mirror row after a local/remote delete.
  // Confirm the source record still exists at this revision before exporting it.
  const params = new URLSearchParams({
    repo: did,
    collection: "community.lexicon.bookmarks.bookmark",
    rkey: bookmark.rkey,
  });
  const response = await fetch(
    `${resolved.pdsUrl}/xrpc/com.atproto.repo.getRecord?${params}`,
    {
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    if (
      (response.status === 400 || response.status === 404) &&
      (await response.clone().json().catch(() => ({}))).error ===
        "RecordNotFound"
    ) return false;
    return null;
  }
  const current = await response.json();
  if (
    typeof current.cid !== "string" ||
    typeof current.value?.subject !== "string"
  ) return null;
  if (
    current.cid !== bookmark.cid || current.value.subject !== bookmark.subject
  ) return false;
  return await getAuthoritativeReadingListTag({
    did,
    pdsUrl: resolved.pdsUrl,
    makeRequest: (_method: string, url: string) =>
      fetch(url, { signal: AbortSignal.timeout(10_000) }),
  });
}

/** Stable per-recipient identity; password rotation retains delivery history.
 * No plaintext account name or credentials are stored in the delivery ledger. */
async function accountKey(username: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(username.trim()),
    ),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function deliverReadingListBookmark(
  { bookmark }: BookmarkSavedEvent,
  readTag: (
    did: string,
    bookmark: BookmarkSavedEvent["bookmark"],
  ) => Promise<string | null | false> = readReadingListTag,
): Promise<void> {
  const { uri, did, subject, cid, tags } = bookmark;
  if (!tags?.length) return;
  const settings = await db.execute({
    sql:
      "SELECT instapaper_username_encrypted FROM user_settings WHERE did = ? AND instapaper_enabled = 1",
    args: [did],
  });
  if (!settings.rows.length) return;
  if (!settings.rows[0][0]) {
    throw new Error("Instapaper credentials incomplete");
  }
  let recipient = await accountKey(await decrypt(String(settings.rows[0][0])));
  const existing = await db.execute({
    sql: `SELECT 1 FROM instapaper_deliveries
      WHERE bookmark_uri = ? AND subject = ? AND account_key = ? AND status = 'sent'`,
    args: [uri, subject, recipient],
  });
  if (existing.rows.length) return;
  const tag = await readTag(did, bookmark);
  if (tag === false) return;
  if (!tag) {
    throw new Error("Authoritative reading-list preference unavailable");
  }
  if (
    !tags.some((item) =>
      typeof item === "string" && item.toLowerCase() === tag.toLowerCase()
    )
  ) return;

  // Network reads may have taken time: check the current record/connection
  // again, and use the latest credentials, before acquiring a send lease.
  const current = await db.execute({
    sql:
      `SELECT s.instapaper_username_encrypted, s.instapaper_password_encrypted,
        COALESCE((SELECT a.title FROM annotations a WHERE a.did = b.did AND a.subject = b.uri LIMIT 1), b.enriched_title)
      FROM bookmarks b JOIN user_settings s ON s.did = b.did
      WHERE b.uri = ? AND b.did = ? AND b.cid = ? AND b.subject = ? AND s.instapaper_enabled = 1`,
    args: [uri, did, cid, subject],
  });
  if (!current.rows.length) return;
  const [encryptedUsername, encryptedPassword, title] = current.rows[0];
  if (!encryptedUsername || !encryptedPassword) {
    throw new Error("Instapaper credentials incomplete");
  }
  const credentials = {
    username: await decrypt(String(encryptedUsername)),
    password: await decrypt(String(encryptedPassword)),
  };

  recipient = await accountKey(credentials.username);
  const token = crypto.randomUUID();
  const now = Date.now();
  const claim = await db.execute({
    sql: `INSERT INTO instapaper_deliveries
        (bookmark_uri, subject, account_key, status, lease_token, lease_until)
      VALUES (?, ?, ?, 'sending', ?, ?)
      ON CONFLICT(bookmark_uri, subject, account_key) DO UPDATE SET
        status = 'sending', lease_token = excluded.lease_token, lease_until = excluded.lease_until
      WHERE instapaper_deliveries.status != 'sent' AND instapaper_deliveries.lease_until <= ?
      RETURNING lease_token`,
    args: [uri, subject, recipient, token, now + 5 * 60_000, now],
  });
  if (!claim.rows.length) {
    const sent = await db.execute({
      sql:
        "SELECT status FROM instapaper_deliveries WHERE bookmark_uri = ? AND subject = ? AND account_key = ?",
      args: [uri, subject, recipient],
    });
    if (sent.rows[0]?.[0] === "sent") return;
    throw new Error("Instapaper delivery is already in progress");
  }
  try {
    const result = await sendToInstapaper(
      subject,
      credentials,
      title ? String(title) : undefined,
    );
    if (!result.success) {
      throw new Error(result.error ?? "Instapaper delivery failed");
    }
    await db.execute({
      sql: `UPDATE instapaper_deliveries SET status = 'sent', delivered_at = ?,
        lease_token = NULL, lease_until = 0 WHERE bookmark_uri = ? AND subject = ? AND account_key = ? AND lease_token = ?`,
      args: [Date.now(), uri, subject, recipient, token],
    });
  } catch (error) {
    await db.execute({
      sql:
        `UPDATE instapaper_deliveries SET status = 'pending', lease_token = NULL, lease_until = 0
        WHERE bookmark_uri = ? AND subject = ? AND account_key = ? AND lease_token = ?`,
      args: [uri, subject, recipient, token],
    });
    throw error;
  }
}
