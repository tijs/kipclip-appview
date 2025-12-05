/**
 * Minimal Turso HTTP client using native fetch.
 * No npm dependencies - works on Deno Deploy without node-fetch issues.
 *
 * Based on Turso's HTTP API: https://docs.turso.tech/sdk/http
 */

interface TursoValue {
  type: "null" | "integer" | "float" | "text" | "blob";
  value?: string;
}

interface TursoRequest {
  type: "execute" | "close";
  stmt?: {
    sql: string;
    args?: TursoValue[];
  };
}

interface TursoRowResult {
  type: "row";
  row: TursoValue[];
}

interface TursoExecuteResult {
  type: "ok";
  response: {
    type: "execute";
    result: {
      cols: { name: string; decltype?: string }[];
      rows: TursoValue[][];
      affected_row_count: number;
      last_insert_rowid: string | null;
    };
  };
}

interface TursoResponse {
  results: TursoExecuteResult[];
}

/**
 * Convert a JavaScript value to Turso's typed format
 */
function toTursoValue(value: unknown): TursoValue {
  if (value === null || value === undefined) {
    return { type: "null" };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { type: "integer", value: String(value) };
    }
    return { type: "float", value: String(value) };
  }
  if (typeof value === "string") {
    return { type: "text", value };
  }
  if (typeof value === "boolean") {
    return { type: "integer", value: value ? "1" : "0" };
  }
  // Default to text for other types
  return { type: "text", value: String(value) };
}

/**
 * Convert a Turso value back to JavaScript
 */
function fromTursoValue(value: TursoValue): unknown {
  if (value.type === "null" || value.value === undefined) {
    return null;
  }
  if (value.type === "integer") {
    return parseInt(value.value, 10);
  }
  if (value.type === "float") {
    return parseFloat(value.value);
  }
  return value.value;
}

export interface TursoClient {
  execute: (query: {
    sql: string;
    args?: unknown[];
  }) => Promise<{ rows: unknown[][] }>;
}

/**
 * Create a Turso HTTP client
 */
export function createTursoHttpClient(config: {
  url: string;
  authToken?: string;
}): TursoClient {
  // Convert libsql:// URL to HTTPS pipeline URL
  let baseUrl = config.url;
  if (baseUrl.startsWith("libsql://")) {
    baseUrl = baseUrl.replace("libsql://", "https://");
  }
  const pipelineUrl = `${baseUrl}/v2/pipeline`;

  return {
    execute: async (query: { sql: string; args?: unknown[] }) => {
      const tursoArgs = query.args?.map(toTursoValue) ?? [];

      const requests: TursoRequest[] = [
        {
          type: "execute",
          stmt: {
            sql: query.sql,
            args: tursoArgs,
          },
        },
        { type: "close" },
      ];

      const response = await fetch(pipelineUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.authToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requests }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Turso HTTP error ${response.status}: ${text}`);
      }

      const data: TursoResponse = await response.json();

      // Extract the first result (the execute response)
      const executeResult = data.results[0];
      if (executeResult?.type !== "ok") {
        throw new Error(`Turso execute failed: ${JSON.stringify(data)}`);
      }

      const result = executeResult.response.result;

      // Convert Turso values back to JavaScript
      const rows = result.rows.map((row) => row.map(fromTursoValue));

      return { rows };
    },
  };
}
