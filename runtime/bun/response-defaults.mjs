/** Bun delays implicit MIME headers until send; preserve Deno's observable defaults. */
export function installResponseDefaults() {
  const NativeResponse = globalThis.Response;
  function headersFor(body, init, json = false) {
    const headers = new Headers(init?.headers);
    if (!headers.has("content-type")) {
      if (json) headers.set("content-type", "application/json");
      else if (typeof body === "string") {
        headers.set("content-type", "text/plain;charset=UTF-8");
      } else if (body instanceof URLSearchParams) {
        headers.set(
          "content-type",
          "application/x-www-form-urlencoded;charset=UTF-8",
        );
      } else if (body instanceof Blob && body.type) {
        headers.set("content-type", body.type);
      }
    }
    // Response itself is a valid ResponseInit; its status getters are not enumerable.
    return {
      ...init,
      status: init?.status,
      statusText: init?.statusText,
      headers,
    };
  }
  // A Proxy preserves the native prototype/instanceof/redirect/error identities.
  globalThis.Response = new Proxy(NativeResponse, {
    construct(target, args) {
      return new target(args[0], headersFor(args[0], args[1]));
    },
    get(target, key) {
      if (key === "json") {
        return (data, init) => target.json(data, headersFor(null, init, true));
      }
      return Reflect.get(target, key);
    },
  });
  return () => {
    globalThis.Response = NativeResponse;
  };
}
