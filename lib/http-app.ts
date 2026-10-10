/** Standard Request/Response route bindings backed by Hono. */
import { type Context as HonoContext, Hono } from "@hono/hono";

export interface ConnectionInfo {
  remoteAddr: { hostname?: string; transport?: string; port?: number };
}
export interface SocketHandlers {
  open?(socket: WebSocket): void;
  message?(socket: WebSocket, event: MessageEvent): void;
  close?(socket: WebSocket, code: number, reason: string): void;
  error?(socket: WebSocket, event: Event): void;
}
export type Upgrade = (
  context: HonoContext,
  handlers: SocketHandlers,
) => Promise<Response>;
export interface Context<State = unknown> {
  req: Request;
  url: URL;
  params: Record<string, string>;
  info: ConnectionInfo;
  state: State;
  next(): Promise<Response>;
  upgrade(handlers: SocketHandlers): Promise<Response>;
}
export type Middleware<State = unknown> = (
  ctx: Context<State>,
) => Response | Promise<Response>;
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}
interface Route {
  path: string;
  method: string;
  matches: RegExp;
}
function pathPattern(path: string): RegExp {
  return new RegExp(
    "^" +
      path.split("/").map((segment) =>
        segment === "*"
          ? "(.*)"
          : segment.startsWith(":")
          ? "([^/]+)"
          : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      ).join("/") + "$",
  );
}

/** Keeps domain handlers framework-independent; Hono owns matching/composition. */
export class App<State = unknown> {
  readonly hono: Hono;
  private routes: Route[] = [];
  private finalized = false;
  config: { trustProxy: boolean; root: string; mode: string };
  private failures = new WeakMap<object, Error>();
  constructor(options: { trustProxy?: boolean; upgrade?: Upgrade } = {}) {
    this.config = {
      trustProxy: options.trustProxy ?? false,
      root: ".",
      mode: "production",
    };
    this.hono = new Hono({
      getPath: (req) => this.routingPath(new URL(req.url).pathname),
    });
    this.hono.onError((error, ctx) => {
      this.failures.set(ctx, error);
      (ctx.env as { failure: Error }).failure = error;
      return new Response(
        error instanceof HttpError ? error.message : "Internal server error",
        { status: error instanceof HttpError ? error.status : 500 },
      );
    });
    this.upgrade = options.upgrade;
  }
  private upgrade?: Upgrade;
  private bind(fn: Middleware<State>) {
    return async (c: HonoContext, next: () => Promise<void>) => {
      const url = new URL(c.req.raw.url);
      url.pathname = url.pathname.replace(/\/+/g, "/");
      if (this.config.trustProxy) {
        const proto = c.req.raw.headers.get("x-forwarded-proto");
        const host = c.req.raw.headers.get("x-forwarded-host");
        if (proto) url.protocol = proto + ":";
        if (host) url.host = host;
      }
      const params: Record<string, string> = c.env.params;
      return await fn({
        req: c.req.raw,
        url,
        params,
        info: c.env?.info ??
          { remoteAddr: { hostname: "localhost", transport: "tcp" } },
        state: (c.env.state ??= {}) as State,
        next: async () => {
          await next();
          const error = this.failures.get(c);
          if (error) throw error; // Preserve exception-unwinding middleware order.
          return c.res;
        },
        upgrade: (handlers) => {
          if (!this.upgrade) {
            throw new Error("WebSocket adapter not configured");
          }
          return this.upgrade(c, handlers);
        },
      });
    };
  }
  use(...args: [Middleware<State>] | [string, Middleware<State>]): this {
    const [path, fn] = typeof args[0] === "string" ? args : ["*", args[0]];
    this.hono.use(path as string, this.bind(fn as Middleware<State>));
    return this;
  }
  private route(method: string, path: string, fn: Middleware<State>): this {
    if (this.finalized) {
      throw new Error("Register routes before creating handler");
    }
    this.routes.push({ method, path, matches: pathPattern(path) });
    this.hono.on(
      method,
      path,
      this.bind((ctx) => {
        const allowed = this.allowedMethods(ctx.url.pathname);
        const requested = ctx.req.method === "HEAD" ? "GET" : ctx.req.method;
        if (!allowed.includes(requested)) {
          throw new HttpError(405, "Method Not Allowed");
        }
        if (this.selectedRoute(ctx.url.pathname)?.path !== path) {
          return ctx.next();
        }
        return fn(ctx);
      }),
    );
    return this;
  }
  private routingPath(path: string): string {
    path = path.replace(/\/+/g, "/");
    const isStatic = (route: Route) => !/[:*]/.test(route.path);
    if (this.routes.some((route) => isStatic(route) && route.path === path)) {
      return path;
    }
    const alternate = path.endsWith("/") ? path.slice(0, -1) : path + "/";
    return path !== "/" &&
        this.routes.some((route) => isStatic(route) && route.path === alternate)
      ? alternate
      : path;
  }
  private selectedRoute(path: string): Route | undefined {
    path = this.routingPath(path);
    return this.routes.find((route) =>
      !/[:*]/.test(route.path) && route.path === path
    ) ??
      this.routes.find((route) =>
        /[:*]/.test(route.path) && route.matches.test(path)
      );
  }
  private allowedMethods(path: string): string[] {
    const selected = this.selectedRoute(path);
    return selected
      ? [
        ...new Set(
          this.routes.filter((route) => route.path === selected.path).map((
            route,
          ) => route.method),
        ),
      ]
      : [];
  }
  get(path: string, fn: Middleware<State>): this {
    return this.route("GET", path, fn);
  }
  post(path: string, fn: Middleware<State>): this {
    return this.route("POST", path, fn);
  }
  patch(path: string, fn: Middleware<State>): this {
    return this.route("PATCH", path, fn);
  }
  put(path: string, fn: Middleware<State>): this {
    return this.route("PUT", path, fn);
  }
  delete(path: string, fn: Middleware<State>): this {
    return this.route("DELETE", path, fn);
  }
  handler(): (req: Request, info?: ConnectionInfo) => Promise<Response> {
    if (!this.finalized) {
      this.finalized = true;
      this.hono.all(
        "*",
        this.bind((ctx) => {
          const methods = this.allowedMethods(ctx.url.pathname);
          if (methods.length) {
            if (ctx.req.method === "OPTIONS") {
              return new Response(null, {
                status: 204,
                headers: { Allow: methods.join(", ") },
              });
            }
            throw new HttpError(405, "Method Not Allowed");
          }
          throw new HttpError(404, "Not Found");
        }),
      );
    }
    return async (req, info) => {
      const path = this.routingPath(new URL(req.url).pathname);
      const selected = this.selectedRoute(path);
      const params: Record<string, string> = Object.create(null);
      const method = req.method === "HEAD" ? "GET" : req.method;
      if (selected && this.allowedMethods(path).includes(method)) {
        const values = selected.matches.exec(path)?.slice(1) ?? [];
        const keys = selected.path.split("/").filter((part) =>
          part.startsWith(":") || part === "*"
        );
        keys.forEach((key, i) => {
          params[key === "*" ? "0" : key.slice(1)] = decodeURI(values[i] ?? "");
        });
      }
      // Parameter decoding precedes middleware: malformed escapes reject the
      // handler without logging, OAuth initialization or other route effects.
      const env = { info, state: {}, params, failure: null as Error | null };
      const response = await this.hono.fetch(req, env);
      // The baseline strips HEAD bodies only on the successful middleware
      // path. Framework exceptions retain their body in synthetic responses.
      if (req.method === "HEAD" && env.failure) {
        return new Response(
          env.failure instanceof HttpError
            ? env.failure.message
            : "Internal server error",
          response,
        );
      }
      return response;
    };
  }
}

/** Socket peer only. Never trust creator-controlled forwarding headers here. */
export function ipFilter<State>(
  options: { allowList: string[] },
): Middleware<State> {
  return (ctx) => {
    const peer = ctx.info.remoteAddr;
    if (peer.transport !== "tcp" && peer.transport !== "udp") return ctx.next();
    return options.allowList.includes(peer.hostname ?? "")
      ? ctx.next()
      : new Response("Forbidden", { status: 403 });
  };
}
