// Entry lifecycle for the GitHub core clone.
//
// The forge itself lives in app.ts (createApp). This file only owns the
// competition lifecycle: bind an ephemeral port, register it with the
// environment, wait until the environment says the trial is done, then
// shut down cleanly. Registration and the done-poll both retry forever
// with exponential backoff, so a slow environment never kills the entry.
// No business logic lives here.

import { createApp } from './app.ts';

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (ENV_URL === '') {
  process.stderr.write(
    '[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n',
  );
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff starting at 250 ms, doubling each attempt, capped
// at 2_000 ms so a struggling environment is retried promptly but not
// hammered.
function retryDelay(attempt: number): number {
  return Math.min(RETRY_INITIAL_MS * 2 ** attempt, RETRY_MAX_MS);
}

// Register this process's port with the environment. A 200 (registered)
// or 409 (already registered) means success. A 400 or 405 is a real
// client error and aborts. Anything else — network failure, timeout, or
// an unexpected status — is retried forever with backoff.
async function register(port: number): Promise<void> {
  let attempt = 0;
  for (;;) {
    let res: Response | null = null;
    try {
      res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Network error or timeout: fall through to the retry below.
    }
    if (res !== null) {
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        const text = await res.text();
        throw new Error(`register failed: HTTP ${res.status} ${text}`);
      }
    }
    await sleep(retryDelay(attempt));
    attempt += 1;
  }
}

// Poll the environment until it reports the trial is done. Any error or
// non-ok response is retried forever with backoff.
async function waitForDone(): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(`${ENV_URL}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Network error, timeout, or bad JSON: fall through to retry.
    }
    await sleep(retryDelay(attempt));
    attempt += 1;
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('server did not bind an ephemeral TCP port');
  }
  const port = addr.port;
  console.log(`[entry] listening on port ${port}`);
  await register(port);
  console.log('[entry] registered; waiting for the env to say done');
  await waitForDone();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  console.log('[entry] done');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(
    `[entry] ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
