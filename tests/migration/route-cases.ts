/** Identical synthetic requests for a future baseline/Hono and runtime matrix. */
export interface RouteCase {
  name: string;
  path: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export const routeCases: RouteCase[] = [
  { name: "api missing", path: "/api/migration-no-route" },
  { name: "api bare prefix", path: "/api" },
  { name: "oauth missing", path: "/oauth/migration-no-route" },
  { name: "login prefix exclusion", path: "/login-other" },
  { name: "bookmarks unauthenticated", path: "/api/bookmarks" },
  { name: "tags unauthenticated", path: "/api/tags" },
  { name: "initial data unauthenticated", path: "/api/initial-data" },
  { name: "settings unauthenticated", path: "/api/settings" },
  { name: "preferences unauthenticated", path: "/api/preferences" },
  { name: "sync status unauthenticated", path: "/api/sync/status" },
  { name: "session unauthenticated", path: "/api/auth/session" },
  { name: "login missing handle", path: "/login" },
  { name: "login malformed handle", path: "/login?handle=bad%20handle" },
  { name: "callback missing parameters", path: "/oauth/callback" },
  {
    name: "callback invalid state",
    path: "/oauth/callback?code=fixture&state=not-json",
  },
  { name: "logout unauthenticated", path: "/api/auth/logout", method: "POST" },
  { name: "version", path: "/api/version" },
  { name: "health", path: "/api/health" },
  { name: "live non-upgrade", path: "/api/live" },
  {
    name: "live unauthenticated",
    path: "/api/live",
    headers: { upgrade: "websocket" },
  },
  {
    name: "metrics invalid",
    path: "/api/metrics",
    method: "POST",
    body: "bad-json",
  },
  {
    name: "share-target fallback",
    path: "/share-target",
    method: "POST",
    body: "text=no+url",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  },
  {
    name: "share-target explicit URL",
    path: "/share-target",
    method: "POST",
    body: "url=https%3A%2F%2Fexample.com&title=Fixture",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  },
  { name: "SPA unsupported method", path: "/migration-page", method: "POST" },
  { name: "SPA automatic OPTIONS", path: "/migration-page", method: "OPTIONS" },
  { name: "static missing", path: "/static/migration-no-file.js" },
  { name: "invalid RSS DID", path: "/share/invalid-did/bmV3cw~~/rss" },
  { name: "robots", path: "/robots.txt" },
  { name: "OpenSearch", path: "/opensearch.xml" },
];

export function caseRequest(testCase: RouteCase): Request {
  return new Request(`https://migration.example${testCase.path}`, {
    method: testCase.method ?? "GET",
    headers: testCase.headers,
    body: testCase.body,
  });
}
