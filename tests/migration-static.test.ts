import "../runtime/deno/install.ts";
import "./test-setup.ts";
import { App } from "../lib/http-app.ts";
import { setStaticSnapshot } from "../lib/static-assets.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { toFileUrl } from "@std/path";
import { app } from "../main.ts";
import {
  getBundleFileName,
  getBundleIntegrity,
  serveFile,
} from "../lib/file-server.ts";
import { encodeTagsForUrl } from "../shared/utils.ts";
import { compareContract, observe } from "./migration/contracts.ts";
import {
  assertIsolated,
  assertSecurity,
  withMockFetch,
} from "./migration/isolation.ts";

assertIsolated();
const handler = app.handler();
const origin = "https://migration.example";

/** Each fixture gets an independent static module's existing per-process cache. */
async function staticFixture(
  manifest: unknown,
  run: (
    handler: ReturnType<App<any>["handler"]>,
    root: string,
  ) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({
    dir: Deno.env.get("TMPDIR"),
    prefix: "kipclip-static-contract-",
  });
  try {
    await Deno.mkdir(`${root}/frontend`);
    await Deno.mkdir(`${root}/static`);
    await Deno.copyFile(
      new URL("../frontend/index.html", import.meta.url),
      `${root}/frontend/index.html`,
    );
    if (manifest !== undefined) {
      await Deno.writeTextFile(
        `${root}/static/manifest.json`,
        JSON.stringify(manifest),
      );
    }
    const module = await import(
      `../routes/static.ts?fixture=${crypto.randomUUID()}`
    );
    const fixtureApp = module.registerStaticRoutes(
      new App(),
      toFileUrl(`${root}/main.ts`).href,
    );
    await run(fixtureApp.handler(), root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("migration oracle compares status, every header, binary bytes and effects", async () => {
  const request = () =>
    new Request(`${origin}/fixture`, { method: "POST", body: "once" });
  const oracle = async (req: Request) =>
    observe(
      new Response(await req.text(), {
        status: 201,
        headers: { "x-fixture": "yes" },
      }),
      ["db-write"],
    );
  await compareContract(request, oracle, oracle);
  for (const field of ["status", "headers", "body", "effects"] as const) {
    await assertRejects(
      () =>
        compareContract(request, oracle, async (req) => {
          const observation = await oracle(req);
          if (field === "status") observation.status = 200;
          if (field === "headers") observation.headers = [];
          if (field === "body") observation.body = [0, 255];
          if (field === "effects") observation.effects = [];
          return observation;
        }),
      Error,
      field,
    );
  }
});

for (const path of ["/", "/bookmarks/deep/link", "/save", "/unknown-page"]) {
  Deno.test(`migration baseline SPA ${path} has HTML, no explicit cache and all security headers`, async () => {
    const res = await handler(new Request(`${origin}${path}`));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
    assertEquals(res.headers.get("cache-control"), null);
    assertSecurity(res);
    assertStringIncludes(await res.text(), '<div id="root">');
  });
}

for (
  const path of [
    "/api",
    "/api/no-route",
    "/apiculture",
    "/oauth",
    "/oauth/no-route",
    "/login/no-route",
    "/login-extra",
  ]
) {
  Deno.test(`migration baseline SPA exclusion ${path} stays 404`, async () => {
    const res = await handler(new Request(`${origin}${path}`));
    assertEquals(res.status, 404);
    assertEquals(await res.text(), "Not Found");
    assertSecurity(res);
  });
}

Deno.test("migration baseline HEAD and unsupported methods preserve framework semantics", async () => {
  const head = await handler(
    new Request(`${origin}/deep/path`, { method: "HEAD" }),
  );
  assertEquals(head.status, 200);
  assertEquals(await head.text(), "");
  assertEquals(head.headers.get("content-type"), "text/html; charset=utf-8");
  assertSecurity(head);
  const post = await handler(
    new Request(`${origin}/deep/path`, { method: "POST" }),
  );
  assertEquals(post.status, 405);
  assertEquals(await post.text(), "Method Not Allowed");
  // baseline's method error is thrown outside the response-unwinding middleware.
  assertEquals(post.headers.get("x-frame-options"), null);
  const options = await handler(
    new Request(`${origin}/deep/path`, { method: "OPTIONS" }),
  );
  assertEquals(options.status, 204);
  assertEquals(options.headers.get("allow"), "GET");
  assertSecurity(options);
});

Deno.test("migration static manifest selects hashed script, injects valid SRI and caches selection", async () => {
  const bundle = new TextEncoder().encode("console.log('migration fixture');");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-384", bundle));
  const integrity = `sha384-${btoa(String.fromCharCode(...digest))}`;
  await staticFixture(
    { "bundle.js": "bundle.abcdef12.js", integrity },
    async (handle, root) => {
      await Deno.writeFile(`${root}/static/bundle.abcdef12.js`, bundle);
      const html = await (await handle(new Request(`${origin}/`))).text();
      assertStringIncludes(html, 'src="/static/bundle.abcdef12.js"');
      assertStringIncludes(
        html,
        `integrity="${integrity}" crossorigin="anonymous"`,
      );
      const asset = await handle(
        new Request(`${origin}/static/bundle.abcdef12.js`),
      );
      assertEquals(
        asset.headers.get("cache-control"),
        "public, max-age=31536000, immutable",
      );
      assertEquals(asset.headers.get("content-length"), String(bundle.length));
      assertEquals(new Uint8Array(await asset.arrayBuffer()), bundle);
      await Deno.writeTextFile(
        `${root}/static/manifest.json`,
        JSON.stringify({ "bundle.js": "bundle.12345678.js" }),
      );
      // Existing routes cache the first manifest, unlike file-server helper reads.
      assertEquals(
        await (await handle(new Request(`${origin}/deep`))).text(),
        html,
      );
      assertEquals(
        await getBundleFileName(toFileUrl(`${root}/main.ts`).href),
        "bundle.12345678.js",
      );
    },
  );
});

for (
  const manifest of [undefined, {}, {
    "bundle.js": "bundle.abcdef12.js",
    integrity: "",
  }, { integrity: 42 }]
) {
  Deno.test(`migration static absent/legacy manifest omits invalid SRI ${JSON.stringify(manifest)}`, async () => {
    await staticFixture(manifest, async (handle, root) => {
      const html = await (await handle(new Request(`${origin}/`))).text();
      const expected = (manifest as any)?.["bundle.js"] ?? "bundle.js";
      assertStringIncludes(html, `src="/static/${expected}"`);
      assert(!html.includes('integrity=""'));
      assert(!html.includes('integrity="42"'));
      assertEquals(
        await getBundleIntegrity(toFileUrl(`${root}/main.ts`).href),
        null,
      );
    });
  });
}

Deno.test("migration static binary/content-type/cache/missing file contract", async () => {
  await staticFixture({}, async (handle, root) => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10, 0]);
    for (
      const [name, mime, cache] of [
        ["fixture.png", "image/png", "public, max-age=3600"],
        ["fixture.css", "text/css; charset=UTF-8", "public, max-age=3600"],
        [
          "fixture.html",
          "text/html; charset=UTF-8",
          "public, max-age=60, must-revalidate",
        ],
        [
          "bundle.abcdef12.js.map",
          "application/json; charset=UTF-8",
          "public, max-age=31536000, immutable",
        ],
      ]
    ) {
      await Deno.writeFile(`${root}/static/${name}`, bytes);
      const res = await handle(new Request(`${origin}/static/${name}`));
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), mime);
      assertEquals(res.headers.get("cache-control"), cache);
      assertEquals(new Uint8Array(await res.arrayBuffer()), bytes);
    }
    const missing = await handle(new Request(`${origin}/static/no-file.js`));
    assertEquals(missing.status, 404);
    assertEquals(await missing.text(), "File not found");
    await Deno.writeTextFile(`${root}/static/manifest.json`, "invalid JSON");
    assertEquals(
      await getBundleFileName(toFileUrl(`${root}/main.ts`).href),
      "bundle.js",
    );
    assertEquals(
      await getBundleIntegrity(toFileUrl(`${root}/main.ts`).href),
      null,
    );
    assertEquals(
      (await serveFile("/missing", toFileUrl(`${root}/main.ts`).href)).status,
      404,
    );
  });
});

Deno.test("migration baseline production snapshot static aliases, ETag, cache bust, HEAD, 405 and favicon", async () => {
  const root = await Deno.makeTempDir({
    dir: Deno.env.get("TMPDIR"),
    prefix: "kipclip-snapshot-contract-",
  });
  try {
    const bytes = new Uint8Array([0, 255, 128]);
    await Deno.writeFile(`${root}/fixture.js`, bytes);
    setStaticSnapshot(app, {
      root,
      version: "migration-build",
      read: (path) => Deno.readFile(path),
      files: new Map([["/fixture.js", {
        filePath: "fixture.js",
        hash: "fixture-hash",
        contentType: "text/javascript; charset=UTF-8",
      }]]),
    });
    const production = app.handler();
    const res = await production(new Request(`${origin}/fixture.js`));
    assertEquals(new Uint8Array(await res.arrayBuffer()), bytes);
    assertEquals(res.headers.get("etag"), 'W/"fixture-hash"');
    assertEquals(res.headers.get("vary"), "If-None-Match");
    assertEquals(
      res.headers.get("cache-control"),
      "no-cache, no-store, max-age=0, must-revalidate",
    );
    assertSecurity(res);
    const cached = await production(
      new Request(`${origin}/fixture.js`, {
        headers: { "if-none-match": 'W/"fixture-hash"' },
      }),
    );
    assertEquals(cached.status, 304);
    assertEquals(await cached.text(), "");
    assertSecurity(cached);
    const head = await production(
      new Request(`${origin}/fixture.js`, { method: "HEAD" }),
    );
    assertEquals(head.status, 200);
    assertEquals(await head.text(), "");
    assertEquals(head.headers.get("content-length"), "3");
    const bust = await production(
      new Request(`${origin}/fixture.js?__frsh_c=migration-build`),
    );
    assertEquals(
      bust.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    await bust.body?.cancel();
    const invalid = await production(
      new Request(`${origin}/fixture.js?__frsh_c=old&keep=yes`),
    );
    assertEquals(invalid.status, 307);
    assertEquals(invalid.headers.get("location"), "/fixture.js?keep=yes");
    assertSecurity(invalid);
    const post = await production(
      new Request(`${origin}/fixture.js`, { method: "POST" }),
    );
    assertEquals(post.status, 405);
    assertEquals(await post.text(), "Method Not Allowed");
    const favicon = await production(new Request(`${origin}/favicon.ico`));
    assertEquals(favicon.status, 404);
    assertEquals(await favicon.text(), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

for (const count of [0, 1, 2]) {
  Deno.test(`migration share metadata title/escaping/count/RSS ${count}`, async () => {
    const tags = ['news<"tag>'];
    const encoded = encodeTagsForUrl(tags);
    await staticFixture({}, async (handle) => {
      await withMockFetch((request) => {
        assertEquals(
          request.url,
          `${origin}/api/share/did:plc:fixture/${encoded}`,
        );
        return Response.json({
          handle: 'alice<"name>',
          bookmarks: Array(count).fill({}),
        });
      }, async (calls) => {
        const url = `${origin}/share/did:plc:fixture/${encoded}`;
        const res = await handle(new Request(url));
        assertEquals(res.status, 200);
        const html = await res.text();
        const title =
          "alice&lt;&quot;name&gt;'s Bookmarks Collection: news&lt;&quot;tag&gt;";
        assertStringIncludes(html, `<title>${title}</title>`);
        assertStringIncludes(html, `property="og:title" content="${title}"`);
        assertStringIncludes(html, `name="twitter:title" content="${title}"`);
        assertStringIncludes(
          html,
          count
            ? `${count} bookmark${count === 1 ? "" : "s"} tagged with`
            : "Bookmark collection tagged with",
        );
        assertStringIncludes(html, `href="${url}/rss"`);
        assertEquals(calls.length, 1);
      });
    });
  });
}

Deno.test("migration share invalid shape and upstream failure return ordinary SPA", async () => {
  await staticFixture({}, async (handle) => {
    const base = await (await handle(new Request(`${origin}/`))).text();
    await withMockFetch(
      () => new Response(null, { status: 503 }),
      async (calls) => {
        const encoded = encodeTagsForUrl(["news"]);
        const failed = await handle(
          new Request(`${origin}/share/did:plc:fixture/${encoded}`),
        );
        assertEquals(failed.status, 200);
        assertEquals(await failed.text(), base);
        const malformed = await handle(
          new Request(`${origin}/share/only-one-segment`),
        );
        assertEquals(await malformed.text(), base);
        assertEquals(calls.length, 1);
      },
    );
  });
});
