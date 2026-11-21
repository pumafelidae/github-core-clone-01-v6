// MCP over POST /mcp: JSON-RPC 2.0, plain JSON replies. Auth first (no Authorization
// header → 401). Malformed JSON → HTTP 400 with JSON-RPC error code -32700.
// DELETE on /mcp → 204. The tools list is frozen: built once, byte-identical on
// every tools/list call.
//
// Six tools, canonical names and schemas:
//   create_repo {owner?, name, description?, private?} required ['name']
//   get_repo {owner, repo} required both
//   create_issue {owner, repo, title, body?} required owner/repo/title
//   list_issues {owner, repo, state?} required owner/repo
//   create_pull_request {owner, repo, title, body?, head, base} required owner/repo/title/head/base
//   merge_pull_request {owner, repo, pull_number} required all three
// Every tool result is {content:[{type:'text', text: JSON.stringify(result)}],
// structuredContent: result}; tool errors are {isError: true, ...}.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';
import { requireAuth, sendError, sendJson, sendNoContent } from './util.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, Record<string, unknown>>;
    readonly required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, Record<string, unknown>>, required: string[]): ToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, required } };
}

/** The frozen tools array: one object, reused for every tools/list call. */
const TOOLS: readonly ToolDefinition[] = Object.freeze([
  tool('create_repo', 'Create a repository for the viewer.', {
    owner: { type: 'string', description: 'Owner of the repository (defaults to the viewer).' },
    name: { type: 'string', description: 'Name of the repository.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'Owner of the repository.' },
    repo: { type: 'string', description: 'Name of the repository.' },
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'Owner of the repository.' },
    repo: { type: 'string', description: 'Name of the repository.' },
    title: { type: 'string', description: 'Title of the issue.' },
    body: { type: 'string', description: 'Body of the issue.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    owner: { type: 'string', description: 'Owner of the repository.' },
    repo: { type: 'string', description: 'Name of the repository.' },
    state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request in a repository.', {
    owner: { type: 'string', description: 'Owner of the repository.' },
    repo: { type: 'string', description: 'Name of the repository.' },
    title: { type: 'string', description: 'Title of the pull request.' },
    body: { type: 'string', description: 'Body of the pull request.' },
    head: { type: 'string', description: 'Name of the head branch.' },
    base: { type: 'string', description: 'Name of the base branch.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Squash-merge a pull request.', {
    owner: { type: 'string', description: 'Owner of the repository.' },
    repo: { type: 'string', description: 'Name of the repository.' },
    pull_number: { type: 'number', description: 'Number of the pull request.' },
  }, ['owner', 'repo', 'pull_number']),
]);

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown } | { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown; isError: true };

function okResult(result: unknown): ToolResult {
  const text = JSON.stringify(result);
  return { content: [{ type: 'text', text }], structuredContent: result };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

export function createMcpHandler(store: Store): (req: IncomingMessage, res: ServerResponse, body: Buffer) => boolean {
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

  /** Run one tool call; returns a ToolResult (isError set on tool-level failures). */
  function callTool(name: string, args: Record<string, unknown>): ToolResult {
    const definition = TOOLS.find((candidate) => candidate.name === name);
    if (definition === undefined) throw new Error(`unknown tool ${JSON.stringify(name)}`);
    for (const required of definition.inputSchema.required) {
      if (args[required] === undefined || args[required] === null || args[required] === '') {
        throw new Error(`missing required argument ${JSON.stringify(required)}`);
      }
    }
    const owner = typeof args.owner === 'string' && args.owner !== '' ? args.owner : store.viewerLogin;
    if (name === 'create_repo') {
      const repoName = String(args.name);
      if (store.getRepo(owner, repoName) !== undefined) {
        return errorResult(`Repository "${repoName}" already exists`);
      }
      const repo = store.createRepo(
        repoName,
        args.private === true,
        typeof args.description === 'string' ? args.description : '',
      );
      return okResult(store.repoJson(repo));
    }
    const repoName = String(args.repo ?? '');
    const repo = owner === store.viewerLogin ? store.getRepo(owner, repoName) : undefined;
    if (repo === undefined) return errorResult(`Repository "${owner}/${repoName}" not found`);
    if (name === 'get_repo') return okResult(store.repoJson(repo));
    if (name === 'create_issue') {
      const issue = store.createIssue(
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        [],
      );
      return okResult(store.issueJson(repo, issue));
    }
    if (name === 'list_issues') {
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = state === 'all' ? [...repo.issues] : repo.issues.filter((issue) => issue.state === state);
      return okResult(issues.map((issue) => store.issueJson(repo, issue)));
    }
    if (name === 'create_pull_request') {
      const head = String(args.head);
      const base = String(args.base);
      if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
        return errorResult(`Head or base branch does not exist: ${head} / ${base}`);
      }
      const pull = store.createPullRequest(
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        head,
        base,
        repo.refs.get(`refs/heads/${head}`) as string,
        repo.refs.get(`refs/heads/${base}`) as string,
      );
      return okResult(store.pullJson(repo, pull));
    }
    if (name === 'merge_pull_request') {
      const pull = repo.pullMap.get(Number(args.pull_number));
      if (pull === undefined) return errorResult(`Pull request #${String(args.pull_number)} not found`);
      if (pull.state !== 'open') return errorResult(`Pull request #${pull.number} is not open`);
      const mergedSha = store.squashMerge(repo, pull);
      if (mergedSha === null) return errorResult(`Pull request #${pull.number} has a merge conflict`);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = store.nowIso();
      pull.mergeCommitSha = mergedSha;
      return okResult({ merged: true, sha: mergedSha, message: `Merge pull request #${pull.number} from ${pull.head}` });
    }
    return errorResult(`Tool ${name} is not implemented`);
  }

  return (req, res, body) => {
    const pathname = new URL(req.url ?? '/', 'http://entry').pathname;
    if (pathname !== '/mcp') return false;
    if (req.method === 'DELETE') {
      sendNoContent(res);
      return true;
    }
    if (req.method !== 'POST') {
      sendError(res, 405, 'Method not allowed');
      return true;
    }
    if (!requireAuth(req, res)) return true;
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return true;
    }
    const id = request.id === undefined ? null : request.id;
    const method = typeof request.method === 'string' ? request.method : '';
    const params = (request.params ?? {}) as Record<string, unknown>;

    // Notifications have no id and get no JSON-RPC reply.
    if (method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return true;
    }
    const reply = (result: unknown): void => {
      sendJson(res, 200, { jsonrpc: '2.0', id, result });
    };
    const replyError = (code: number, message: string): void => {
      sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
    };
    if (method === 'server/discover') {
      reply({
        serverInfo,
        capabilities: { tools: {} },
        supportedVersions: ['2026-07-28', '2025-11-25'],
        protocolVersion: PROTOCOL_VERSION,
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      });
      return true;
    }
    if (method === 'initialize') {
      reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo });
      return true;
    }
    if (method === 'tools/list') {
      reply({ tools: TOOLS });
      return true;
    }
    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = callTool(toolName, args);
        reply(result);
      } catch (err) {
        replyError(-32602, err instanceof Error ? err.message : 'Invalid params');
      }
      return true;
    }
    replyError(-32601, `Method not found: ${method}`);
    return true;
  };
}
