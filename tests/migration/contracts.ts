/** Framework-neutral parity oracle. No server/framework/runtime dependencies. */
export type RequestHandler = (request: Request) => Response | Promise<Response>;

export interface Observation {
  status: number;
  headers: [string, string][];
  body: number[];
  effects: unknown;
}

/** Consume bytes, not text: binary static assets are part of the contract. */
export async function observe(
  response: Response,
  effects: unknown = null,
): Promise<Observation> {
  return {
    status: response.status,
    headers: [...response.headers.entries()].sort(([a], [b]) =>
      a.localeCompare(b)
    ),
    body: [...new Uint8Array(await response.arrayBuffer())],
    effects,
  };
}

/**
 * Both sides get independent requests AND isolated fixture setup/teardown.
 * The caller must explicitly normalize random cookie values/timestamps after
 * verifying their semantics. No headers, bodies or side effects are ignored.
 */
export async function compareContract(
  makeRequest: () => Request,
  runOracle: (request: Request) => Promise<Observation>,
  runCandidate: (request: Request) => Promise<Observation>,
): Promise<void> {
  const expected = await runOracle(makeRequest());
  const actual = await runCandidate(makeRequest());
  const differences = (Object.keys(expected) as (keyof Observation)[])
    .filter((key) =>
      JSON.stringify(expected[key]) !== JSON.stringify(actual[key])
    );
  if (differences.length) {
    throw new Error(
      `Route contract differs in ${differences.join(", ")}\n` +
        `oracle: ${JSON.stringify(expected)}\ncandidate: ${
          JSON.stringify(actual)
        }`,
    );
  }
}
