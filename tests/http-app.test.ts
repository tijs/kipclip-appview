import "../runtime/deno/install.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { App } from "../lib/http-app.ts";

Deno.test("HTTP bindings select most-specific route before checking method", async () => {
  const app = new App().post("/auth/logout", () => Response.json({ ok: true }))
    .get("*", () => new Response("SPA"));
  const handler = app.handler();
  for (const method of ["GET", "HEAD", "PUT"]) {
    const res = await handler(
      new Request("https://fixture.example/auth/logout", { method }),
    );
    assertEquals(res.status, 405);
    assertEquals(await res.text(), "Method Not Allowed");
  }
  const options = await handler(
    new Request("https://fixture.example/auth/logout", { method: "OPTIONS" }),
  );
  assertEquals(options.status, 204);
  assertEquals(options.headers.get("allow"), "POST");
});

Deno.test("HTTP bindings preserve parameter order and decodeURI semantics", async () => {
  const app = new App().get(
    "/params/:did/:rkey",
    (ctx) => Response.json(ctx.params),
  );
  const res = await app.handler()(
    new Request("https://fixture.example/params/did%3Aplc%3Atest/%41"),
  );
  assertEquals(await res.text(), '{"did":"did%3Aplc%3Atest","rkey":"A"}');
});

Deno.test("HTTP bindings normalize routing/proxy URL without mutating Request", async () => {
  const app = new App({ trustProxy: true }).get(
    "/params/:name",
    (ctx) =>
      Response.json({
        name: ctx.params.name,
        raw: ctx.req.url,
        proxy: ctx.url.href,
      }),
  );
  const res = await app.handler()(
    new Request("http://127.0.0.1:8888/params//value", {
      headers: {
        "x-forwarded-host": "proxy.example",
        "x-forwarded-proto": "https",
      },
    }),
  );
  assertEquals(await res.json(), {
    name: "value",
    raw: "http://127.0.0.1:8888/params//value",
    proxy: "https://proxy.example:8888/params/value",
  });
});

Deno.test("HTTP bindings successful HEAD strips body, error HEAD retains synthetic body", async () => {
  const app = new App().get("/okay", () => new Response("body")).get(
    "/error",
    () => {
      throw new Error("fixture");
    },
  );
  const handler = app.handler();
  const okay = await handler(
    new Request("https://fixture.example/okay", { method: "HEAD" }),
  );
  assertEquals(await okay.text(), "");
  const error = await handler(
    new Request("https://fixture.example/error", { method: "HEAD" }),
  );
  assertEquals(error.status, 500);
  assertEquals(await error.text(), "Internal server error");
});

Deno.test("HTTP bindings propagate errors through outer middleware without response unwinding", async () => {
  const calls: string[] = [];
  const app = new App().use(async (ctx) => {
    calls.push("outer");
    try {
      return await ctx.next();
    } catch (error) {
      calls.push("capture");
      throw error;
    }
  }).use(async (ctx) => {
    const res = await ctx.next();
    calls.push("security");
    return res;
  }).get("/error", () => {
    throw new Error("fixture");
  });
  const res = await app.handler()(new Request("https://fixture.example/error"));
  assertEquals(res.status, 500);
  assertEquals(calls, ["outer", "capture"]);
});

Deno.test("HTTP bindings reject malformed params before middleware side effects", async () => {
  const calls: string[] = [];
  const app = new App().use((ctx) => {
    calls.push("middleware");
    return ctx.next();
  }).get("/params/:value", (ctx) => Response.json(ctx.params));
  const handler = app.handler();
  for (const value of ["%zz", "%E0%A4%A"]) {
    await assertRejects(
      () => handler(new Request("https://fixture.example/params/" + value)),
      URIError,
      "URI malformed",
    );
  }
  assertEquals(calls, []);
});

Deno.test("HTTP bindings accept static slash alternate, not dynamic slash alternate", async () => {
  const app = new App().get("/fixed", (ctx) => new Response(ctx.url.pathname))
    .get("/dynamic/:name", (ctx) => new Response(ctx.params.name));
  const handler = app.handler();
  const fixed = await handler(new Request("https://fixture.example/fixed/"));
  assertEquals(fixed.status, 200);
  assertEquals(await fixed.text(), "/fixed/");
  assertEquals(
    (await handler(new Request("https://fixture.example/dynamic/value/")))
      .status,
    404,
  );
});
