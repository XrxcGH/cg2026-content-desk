/**
 * Minimal start.gg GraphQL client.
 *
 * One endpoint, bearer auth, JSON in and out. No client library: the whole
 * API surface this project uses is a single query, and this has to be
 * debuggable at 11pm on a Saturday by whoever is still awake.
 *
 * start.gg rate-limits at 80 requests/minute. The adapter polls once a minute,
 * so we never get near it, but the client still refuses to be called more
 * than once a second as a backstop against a polling bug turning into a ban.
 */

export const STARTGG_ENDPOINT = 'https://api.start.gg/gql/alpha';

export interface StartggClientOpts {
  token: string;
  endpoint?: string;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
}

export class StartggClient {
  #token: string;
  #endpoint: string;
  #fetch: typeof fetch;
  #lastRequestAt = 0;

  constructor(opts: StartggClientOpts) {
    this.#token = opts.token;
    this.#endpoint = opts.endpoint ?? STARTGG_ENDPOINT;
    this.#fetch = opts.fetchFn ?? fetch;
  }

  async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const since = Date.now() - this.#lastRequestAt;
    if (since < 1000) await new Promise(r => setTimeout(r, 1000 - since));
    this.#lastRequestAt = Date.now();

    const res = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.#token}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) throw new Error(`start.gg HTTP ${res.status}`);
    const body = await res.json() as { data?: T; errors?: { message?: string }[] };
    if (body.errors?.length) {
      throw new Error(`start.gg: ${body.errors.map(e => e.message ?? 'unknown error').join('; ')}`);
    }
    if (!body.data) throw new Error('start.gg: empty response');
    return body.data;
  }
}
