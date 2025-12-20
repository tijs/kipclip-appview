/**
 * Tests for encryption utilities.
 * Verifies encryption/decryption with mocked environment.
 */

import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { decrypt, encrypt } from "../lib/encryption.ts";

// Set test encryption key
Deno.env.set(
  "ENCRYPTION_KEY",
  "test-encryption-key-for-unit-tests-only-minimum-32-chars",
);

Deno.test("encrypt - encrypts plaintext to base64 string", async () => {
  const plaintext = "my-secret-password";
  const ciphertext = await encrypt(plaintext);

  // Should be base64 encoded
  assertEquals(typeof ciphertext, "string");
  assertNotEquals(ciphertext, plaintext);

  // Should contain IV + ciphertext (at least 16 bytes base64)
  assertEquals(ciphertext.length > 16, true);
});

Deno.test("decrypt - decrypts ciphertext back to plaintext", async () => {
  const plaintext = "my-secret-password";
  const ciphertext = await encrypt(plaintext);
  const decrypted = await decrypt(ciphertext);

  assertEquals(decrypted, plaintext);
});

Deno.test(
  "encrypt - produces different ciphertext each time (random IV)",
  async () => {
    const plaintext = "my-secret-password";
    const ciphertext1 = await encrypt(plaintext);
    const ciphertext2 = await encrypt(plaintext);

    // Different IVs should produce different ciphertexts
    assertNotEquals(ciphertext1, ciphertext2);

    // But both should decrypt to same plaintext
    assertEquals(await decrypt(ciphertext1), plaintext);
    assertEquals(await decrypt(ciphertext2), plaintext);
  },
);

Deno.test("decrypt - throws on invalid ciphertext", async () => {
  await assertRejects(
    async () => await decrypt("invalid-base64!@#"),
    Error,
  );
});

Deno.test("encrypt/decrypt - handles special characters", async () => {
  const plaintext = "pässwörd with spëcial chàrs! 🔐";
  const ciphertext = await encrypt(plaintext);
  const decrypted = await decrypt(ciphertext);

  assertEquals(decrypted, plaintext);
});

Deno.test("encrypt/decrypt - handles empty string", async () => {
  const plaintext = "";
  const ciphertext = await encrypt(plaintext);
  const decrypted = await decrypt(ciphertext);

  assertEquals(decrypted, plaintext);
});
