/** Normalize a login identifier and retain authorization server URLs unchanged. */
export function prepareLoginIdentifier(input: string):
  | { valid: true; value: string }
  | { valid: false; error: string } {
  const trimmed = input.trim();
  if (trimmed.startsWith("https://")) return { valid: true, value: trimmed };
  const value = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  if (!value) return { valid: false, error: "Handle is required" };
  if (!value.includes(".")) {
    return {
      valid: false,
      error: "Handle must include a domain (e.g., alice.bsky.social)",
    };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(value)) {
    return { valid: false, error: "Handle contains invalid characters" };
  }
  if (value.includes("..")) {
    return { valid: false, error: "Handle cannot contain consecutive dots" };
  }
  return { valid: true, value };
}
