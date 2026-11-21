// The entrypoint: one node:http server, no install step, stdlib only.
//
// Routing order:
//   GET /healthz            → {ok: true} (no auth)
//   /{owner}/{repo}.git/*   → git smart HTTP (no token)
//   GET /api/v3/repos/:o/:r/issues/:n  → V1 single-issue fast path (auth first,
//     then the store's serialized-body cache; a miss serializes from issueMap
//     and stores the body) — BEFORE the generic REST router
//   /api/v3/*               → REST (auth inside)
//   /api/graphql            → GraphQL (auth inside)
//   /mcp                    → MCP (auth inside)
//   anything else           → 404 JSON
//
// Every handler is wrapped so a malformed request (bad pkt-lines, bad JSON) can
// never kill the server: it answers 400 and keeps serving.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { GitService } from './git.ts';
import { createGraphQLHandler } from './graphql.ts';
import { createMcpHandler } from './mcp.ts';
import { createRestHandler } from './rest.ts';
import { Store } from './store.ts';
import { JSON_TYPE, parseJsonBody, requireAuth, sendBytes, sendError, sendJson, sendNotFound, splitPath } from './util.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** The V1 fast path: a GET for one issue, matched by an anchored regex. */
const SINGLE_ISSUE = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/;

export function createApp(): ReturnType<typeof createServer> {
  const store = new Store();
  const git = new GitService(store);
  const restHandler = createRestHandler(store);
  const graphqlHandler = createGraphQLHandler(store);
  const mcpHandler = createMcpHandler(store);

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        if (tooLarge) {
          sendError(res, 413, 'Request body is too large');
          return;
        }
        const body = Buffer.concat(chunks);
        handle(req, res, body);
      } catch (err) {
        if (!res.headersSent) sendError(res, 500, err instanceof Error ? err.message : 'Internal server error');
        else res.end();
      }
    });
    req.on('error', () => {
      if (!res.headersSent) sendError(res, 400, 'Request failed');
      else res.end();
    });
  });

  function handle(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://entry');
    const pathname = url.pathname;

    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/... — match on the .git/ segment.
    const gitSegments = splitPath(pathname);
    if (gitSegments.length >= 3 && (gitSegments[1] as string).endsWith('.git')) {
      if (git.handleGit(req, res, body, pathname, gitSegments)) return;
      sendNotFound(res, 'Not Found');
      return;
    }

    if (pathname.startsWith('/api/v3')) {
      // V1 fast path, before the generic REST router.
      if (method === 'GET') {
        const match = SINGLE_ISSUE.exec(pathname);
        if (match !== null) {
          if (!requireAuth(req, res)) return;
          const [, owner, repoName, numberRaw] = match as RegExpExecArray;
          const repo = owner === store.viewerLogin ? store.getRepo(owner as string, repoName as string) : undefined;
          if (repo === undefined) {
            sendNotFound(res, 'Not Found');
            return;
          }
          const number = Number(numberRaw);
          const issue = repo.issueMap.get(number);
          if (issue === undefined) {
            sendNotFound(res, 'Not Found');
            return;
          }
          const key = store.cacheKey(repo, number);
          const cached = store.issueCache.get(key);
          if (cached !== undefined) {
            // Send the cached body verbatim, with a fresh request id each time.
            sendBytes(res, 200, cached, JSON_TYPE);
            return;
          }
          const serialized = store.issueJson(repo, issue);
          store.cacheIssue(repo, issue.number, serialized);
          sendJson(res, 200, serialized);
          return;
        }
      }
      // Generic REST router: the body is parsed exactly once, here.
      let parsedBody: unknown = null;
      if (body.length > 0) {
        try {
          parsedBody = parseJsonBody(body) as JsonBody;
        } catch (err) {
          sendError(res, 400, err instanceof Error ? err.message : 'Request body is not valid JSON');
          return;
        }
      }
      if (restHandler(req, res, parsedBody)) return;
      sendNotFound(res, 'Not Found');
      return;
    }

    if (pathname === '/api/graphql') {
      if (graphqlHandler(req, res, body)) return;
      sendNotFound(res, 'Not Found');
      return;
    }

    if (pathname === '/mcp') {
      if (mcpHandler(req, res, body)) return;
      sendNotFound(res, 'Not Found');
      return;
    }

    sendNotFound(res, 'Not Found');
  }

  return server;
}
