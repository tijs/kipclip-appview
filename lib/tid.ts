/**
 * AT Protocol TID (Timestamp Identifier) generation.
 *
 * TIDs are 13-character base32-sortable strings encoding a microsecond
 * timestamp and a 10-bit clock ID. They sort lexicographically in
 * chronological order, which is what the PDS expects for rkeys.
 *
 * @see https://atproto.com/specs/record-key#record-key-type-tid
 */

const B32_CHARSET = "234567abcdefghijklmnopqrstuvwxyz";

let lastTimestamp = 0n;
let clockId = 0;

/**
 * Generate a TID for the current time.
 * Guarantees monotonically increasing values even when called multiple
 * times within the same microsecond (bumps clockId).
 */
export function generateTid(): string {
  let timestampUs = BigInt(Date.now()) * 1000n;

  if (timestampUs <= lastTimestamp) {
    // Same or earlier microsecond — increment clockId to stay unique
    clockId++;
    if (clockId >= 1024) {
      // Clock ID overflow — bump timestamp
      timestampUs = lastTimestamp + 1n;
      clockId = 0;
    }
    timestampUs = lastTimestamp;
  } else {
    clockId = 0;
  }
  lastTimestamp = timestampUs;

  return encodeTid(timestampUs, clockId);
}

/**
 * Generate a TID for a specific timestamp (e.g. imported bookmark dates).
 * Uses a random clock ID to avoid collisions between imports.
 */
export function generateTidForTimestamp(date: Date): string {
  const timestampUs = BigInt(date.getTime()) * 1000n;
  const randomClockId = Math.floor(Math.random() * 1024);
  return encodeTid(timestampUs, randomClockId);
}

/**
 * Generate a TID cursor that sorts just after any record created up to now.
 * Useful for listRecords pagination to get newest records first.
 */
export function newestTidCursor(): string {
  // 1 minute in the future to cover clock skew and processing delay
  const futureUs = BigInt(Date.now() + 60_000) * 1000n;
  return encodeTid(futureUs, 0);
}

function encodeTid(timestampUs: bigint, clockId: number): string {
  const val = (timestampUs << 10n) | BigInt(clockId);
  let n = val;
  const chars: string[] = [];
  for (let i = 0; i < 13; i++) {
    chars.push(B32_CHARSET[Number(n & 0x1fn)]);
    n >>= 5n;
  }
  return chars.reverse().join("");
}
