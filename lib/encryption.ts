/**
 * Encryption utilities for sensitive user data.
 * Uses Web Crypto API with AES-GCM for secure encryption.
 */

const ENCRYPTION_KEY = Deno.env.get("ENCRYPTION_KEY");
const ALGORITHM = "AES-GCM";
const KEY_LENGTH = 256;

/**
 * Derive a CryptoKey from the ENCRYPTION_KEY environment variable.
 * Cached for performance.
 */
let cachedKey: CryptoKey | null = null;

async function getEncryptionKey(): Promise<CryptoKey> {
  if (!ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY environment variable is required");
  }

  if (cachedKey) {
    return cachedKey;
  }

  // Derive key from environment variable using PBKDF2
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(ENCRYPTION_KEY),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  cachedKey = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: encoder.encode("kipclip-instapaper-v1"), // Static salt for deterministic key
      iterations: 100000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );

  return cachedKey;
}

/**
 * Encrypt a plaintext string.
 * Returns base64-encoded ciphertext with IV prepended.
 */
export async function encrypt(plaintext: string): Promise<string> {
  const key = await getEncryptionKey();
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  // Generate random IV (12 bytes for GCM)
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    data,
  );

  // Prepend IV to ciphertext (IV is not secret)
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  // Return base64-encoded string
  return btoa(String.fromCharCode(...combined));
}

/**
 * Decrypt a ciphertext string.
 * Expects base64-encoded ciphertext with IV prepended.
 */
export async function decrypt(ciphertext: string): Promise<string> {
  const key = await getEncryptionKey();

  // Decode base64
  const combined = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));

  // Extract IV (first 12 bytes) and ciphertext
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    data,
  );

  const decoder = new TextDecoder();
  return decoder.decode(plaintext);
}
