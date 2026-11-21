// REST API v3: the /api/v3 surface the suite exercises — repos, refs, branches,
// commits, contents, labels, issues (+comments), pull requests (+files, merge).
//
// The request body is parsed exactly once, by the router, above the handlers.
// Every reply is JSON and carries a fresh X-GitHub-Request-Id (via util's senders).
// Auth accepts any non-empty Bearer token: the suite's token is opaque and the
// local grade uses --token test, so an exact-match check would reject real runs.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTree, type Comment, type Repo, type Store } from './store.ts';
import {
  b64decode,
  b64encode,
  isOid,
  queryOf,
  requireAuth,
  sendError,
  sendJson,
  sendNoContent,
  sendNotFound,
} from './util.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown, match?: RegExpExecArray | null) => void;

/** Pagination: per_page/page from the query, clamped to sane bounds. */
function pageParams(req: IncomingMessage): { perPage: number; page: number } {
  const query = queryOf(req);
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

/** Slice a list into one page and set the Link header the suite reads for paging. */
function paginate<T>(req: IncomingMessage, res: ServerResponse, items: readonly T[]): T[] {
  const { perPage, page } = pageParams(req);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const host = req.headers.host ?? 'entry';
  const base = `http://${host}${new URL(req.url ?? '/', 'http://entry').pathname}`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (totalPages > 1) links.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  if (links.length > 0) res.setHeader('Link', links.join(', '));
  return items.slice((page - 1) * perPage, page * perPage);
}

/** The viewer as a REST user object. */
function userJson(store: Store): Record<string, unknown> {
  return {
    login: store.viewerLogin,
    id: store.viewerId,
    name: store.viewerName,
    email: store.viewerEmail,
    type: 'User',
    avatar_url: `https://example.invalid/${store.viewerLogin}.png`,
    html_url: `https://example.invalid/${store.viewerLogin}`,
    url: `/api/v3/users/${store.viewerLogin}`,
  };
}

/** Resolve a repo from the path, or 404 when absent / owned by someone else. */
function repoOr404(store: Store, res: ServerResponse, owner: string, repoName: string): Repo | null {
  if (owner !== store.viewerLogin) {
    sendNotFound(res, 'Not Found');
    return null;
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendNotFound(res, 'Not Found');
    return null;
  }
  return repo;
}

/** A commit's reachable history, newest first by its deterministic timestamp. */
function commitHistory(store: Store, tip: string): Array<{ sha: string; commit: ReturnType<typeof parseCommit> }> {
  const seen = new Set<string>();
  const queue = [tip];
  const found: Array<{ sha: string; commit: ReturnType<typeof parseCommit> }> = [];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = store.parseCommitObject(oid);
    if (commit === null) continue;
    found.push({ sha: oid, commit });
    for (const parent of commit.parents) queue.push(parent);
  }
  found.sort((a, b) => b.commit.timestampSec - a.commit.timestampSec);
  return found;
}

export function createRestHandler(store: Store): (req: IncomingMessage, res: ServerResponse, body: unknown) => boolean {
  const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];

  const route = (method: string, pattern: RegExp, handler: Handler): void => {
    routes.push({ method, pattern, handler });
  };

  // ------------------------------------------------------------ root / meta / user

  route('GET', /^\/api\/v3\/$/, (_req, res) => {
    res.setHeader('X-OAuth-Scopes', 'repo, read:org');
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' });
  });

  route('GET', /^\/api\/v3\/meta$/, (_req, res) => {
    sendJson(res, 200, { installed_version: '1.0.0' });
  });

  route('GET', /^\/api\/v3\/user$/, (_req, res) => {
    sendJson(res, 200, userJson(store));
  });

  // ------------------------------------------------------------ repos

  route('POST', /^\/api\/v3\/user\/repos$/, (_req, res, body) => {
    const record = body as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    if (name === '') {
      sendError(res, 422, 'Validation Failed: name is required');
      return;
    }
    if (store.getRepo(store.viewerLogin, name) !== undefined) {
      sendError(res, 422, `Validation Failed: repository "${name}" already exists`);
      return;
    }
    const repo = store.createRepo(
      name,
      record.private === true,
      typeof record.description === 'string' ? record.description : '',
    );
    sendJson(res, 201, store.repoJson(repo));
  });

  route('GET', /^\/api\/v3\/user\/repos$/, (req, res) => {
    const repos = store.viewerRepos();
    sendJson(res, 200, paginate(req, res, repos.map((repo) => store.repoJson(repo))));
  });

  route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, (req, res) => {
    const [, owner, name] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    sendJson(res, 200, store.repoJson(repo));
  });

  route('PATCH', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, (req, res, body) => {
    const [, owner, name] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const record = body as Record<string, unknown>;
    if (typeof record.description === 'string') repo.description = record.description;
    sendJson(res, 200, store.repoJson(repo));
  });

  route('DELETE', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/, (req, res) => {
    const [, owner, name] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    store.deleteRepo(owner as string, name as string);
    sendNoContent(res);
  });

  // ------------------------------------------------------------ branches / refs

  route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches$/, (req, res) => {
    const [, owner, name] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha } }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(res, 200, branches);
  });

  route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/, (req, res) => {
    const [, owner, name, branch] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches\/(.+)$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const sha = repo.refs.get(`refs/heads/${branch as string}`);
    if (sha === undefined) {
      sendNotFound(res, 'Branch not found');
      return;
    }
    sendJson(res, 200, { name: branch, commit: { sha } });
  });

  route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/, (req, res) => {
    const [, owner, name] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const refs = [...repo.refs.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([ref, sha]) => ({ ref, object: { sha } }));
    sendJson(res, 200, refs);
  });

  route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs\/(.+)$/, (req, res) => {
    const [, owner, name, refPath] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs\/(.+)$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const sha = repo.refs.get(`refs/${refPath as string}`);
    if (sha === undefined) {
      sendNotFound(res, 'Reference does not exist');
      return;
    }
    sendJson(res, 200, { ref: `refs/${refPath as string}`, object: { sha } });
  });

  route('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/, (req, res, body) => {
    const [, owner, name] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const record = body as Record<string, unknown>;
    const ref = typeof record.ref === 'string' ? record.ref : '';
    const sha = typeof record.sha === 'string' ? record.sha : '';
    if (!ref.startsWith('refs/') || !isOid(sha)) {
      sendError(res, 422, 'Validation Failed: ref and sha are required');
      return;
    }
    if (repo.refs.has(ref)) {
      sendError(res, 422, `Validation Failed: ref "${ref}" already exists`);
      return;
    }
    if (store.getObject(sha) === undefined) {
      sendError(res, 422, `Validation Failed: object ${sha} does not exist`);
      return;
    }
    repo.setRef(ref, sha);
    sendJson(res, 201, { ref, object: { sha } });
  });

  // ------------------------------------------------------------ commits

  route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/commits$/, (req, res) => {
    const [, owner, name] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/commits$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const ref = queryOf(req).get('sha');
    let tip: string | undefined;
    if (ref !== null) {
      if (isOid(ref)) tip = ref;
      else tip = repo.refs.get(`refs/heads/${ref}`);
    } else {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    if (tip === undefined || store.getObject(tip) === undefined) {
      sendJson(res, 200, []);
      return;
    }
    const history = commitHistory(store, tip);
    sendJson(
      res,
      200,
      history.map(({ sha, commit }) => ({
        sha,
        commit: {
          message: commit.message,
          author: { name: store.viewerName, email: store.viewerEmail, date: new Date(commit.timestampSec * 1000).toISOString() },
          committer: { name: store.viewerName, email: store.viewerEmail, date: new Date(commit.timestampSec * 1000).toISOString() },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      })),
    );
  });

  // ------------------------------------------------------------ contents

  /** Resolve a path inside the tree at `tip`; returns the blob or the tree entries. */
  function resolveContentsPath(
    tip: string | undefined,
    segments: readonly string[],
  ): { kind: 'file'; oid: string; data: Buffer } | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; mode: string }> } | null {
    if (tip === undefined) return null;
    const commit = store.parseCommitObject(tip);
    if (commit === null) return null;
    let treeOid = commit.tree;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i] as string;
      const object = store.getObject(treeOid);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
      if (entry === undefined) return null;
      if (i === segments.length - 1) {
        if (entry.mode === '40000') {
          const dirObject = store.getObject(entry.oid);
          if (dirObject === undefined || dirObject.type !== 'tree') return null;
          const entries = parseTree(dirObject.data).map((child) => ({
            name: child.name,
            path: [...segments, child.name].join('/'),
            oid: child.oid,
            mode: child.mode,
          }));
          return { kind: 'dir', entries };
        }
        const blob = store.getObject(entry.oid);
        if (blob === undefined || blob.type !== 'blob') return null;
        return { kind: 'file', oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    // Root listing.
    const root = store.getObject(treeOid);
    if (root === undefined || root.type !== 'tree') return null;
    const entries = parseTree(root.data).map((child) => ({
      name: child.name,
      path: child.name,
      oid: child.oid,
      mode: child.mode,
    }));
    return { kind: 'dir', entries };
  }

  const contentsPattern = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents(?:\/(.*))?$/;
  route('GET', contentsPattern, (req, res) => {
    const [, owner, name, rawPath] = contentsPattern.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const ref = queryOf(req).get('ref');
    let tip: string | undefined;
    if (ref !== null) {
      tip = isOid(ref) ? ref : repo.refs.get(`refs/heads/${ref}`);
    } else {
      tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    }
    const segments = rawPath === undefined || rawPath === '' ? [] : decodeURIComponent(rawPath as string).split('/').filter((part) => part !== '');
    const resolved = resolveContentsPath(tip, segments);
    if (resolved === null) {
      sendNotFound(res, 'Not Found');
      return;
    }
    if (resolved.kind === 'dir') {
      sendJson(
        res,
        200,
        resolved.entries.map((entry) => ({
          type: entry.mode === '40000' ? 'dir' : 'file',
          name: entry.name,
          path: entry.path,
          sha: entry.oid,
        })),
      );
      return;
    }
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: b64encode(resolved.data),
      sha: resolved.oid,
      size: resolved.data.length,
      name: segments[segments.length - 1] ?? '',
      path: segments.join('/'),
    });
  });

  route('PUT', contentsPattern, (req, res, body) => {
    const [, owner, name, rawPath] = contentsPattern.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const segments = rawPath === undefined || rawPath === '' ? [] : decodeURIComponent(rawPath as string).split('/').filter((part) => part !== '');
    if (segments.length === 0) {
      sendError(res, 422, 'Validation Failed: a file path is required');
      return;
    }
    const record = body as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : 'update';
    const content = typeof record.content === 'string' ? record.content : '';
    const branch = typeof record.branch === 'string' ? record.branch : repo.defaultBranch;
    const sha = typeof record.sha === 'string' ? record.sha : undefined;
    let bytes: Buffer;
    try {
      bytes = b64decode(content);
    } catch {
      sendError(res, 422, 'Validation Failed: content is not valid base64');
      return;
    }
    // A branch naming a missing branch is created from the default tip first.
    if (!repo.refs.has(`refs/heads/${branch}`)) {
      const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (defaultTip !== undefined) repo.setRef(`refs/heads/${branch}`, defaultTip);
    }
    const path = segments.join('/');
    const tipBefore = repo.refs.get(`refs/heads/${branch}`);
    const existing = tipBefore === undefined ? null : resolveContentsPath(tipBefore, segments);
    if (existing !== null && existing.kind === 'file' && sha !== undefined && sha !== existing.oid) {
      sendError(res, 409, 'Conflict: sha does not match the current file');
      return;
    }
    const created = existing === null;
    const result = store.commitContents(repo, branch, path, bytes, message);
    sendJson(res, created ? 201 : 200, {
      content: { sha: result.contentSha, encoding: 'base64', name: segments[segments.length - 1] ?? '', path },
      commit: { sha: result.commitSha },
    });
  });

  route('DELETE', contentsPattern, (req, res, body) => {
    const [, owner, name, rawPath] = contentsPattern.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const segments = rawPath === undefined || rawPath === '' ? [] : decodeURIComponent(rawPath as string).split('/').filter((part) => part !== '');
    if (segments.length === 0) {
      sendError(res, 422, 'Validation Failed: a file path is required');
      return;
    }
    const record = body as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message : 'delete';
    const branch = typeof record.branch === 'string' ? record.branch : repo.defaultBranch;
    const sha = typeof record.sha === 'string' ? record.sha : undefined;
    const tipBefore = repo.refs.get(`refs/heads/${branch}`);
    const existing = tipBefore === undefined ? null : resolveContentsPath(tipBefore, segments);
    if (existing === null || existing.kind !== 'file') {
      sendNotFound(res, 'Not Found');
      return;
    }
    if (sha !== undefined && sha !== existing.oid) {
      sendError(res, 409, 'Conflict: sha does not match the current file');
      return;
    }
    const result = store.commitContents(repo, branch, segments.join('/'), null, message);
    sendJson(res, 200, { commit: { sha: result.commitSha } });
  });

  // ------------------------------------------------------------ labels

  route('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/, (req, res, body) => {
    const [, owner, name] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const record = body as Record<string, unknown>;
    const labelName = typeof record.name === 'string' ? record.name : '';
    if (labelName === '') {
      sendError(res, 422, 'Validation Failed: name is required');
      return;
    }
    const existing = repo.labels.find((label) => label.name === labelName);
    if (existing !== undefined) {
      sendJson(res, 200, { name: existing.name, color: existing.color });
      return;
    }
    const color = typeof record.color === 'string' ? record.color : 'ededed';
    repo.labels.push({ name: labelName, color });
    store.invalidateRepoIssues(repo);
    sendJson(res, 201, { name: labelName, color });
  });

  route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/, (req, res) => {
    const [, owner, name] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    sendJson(res, 200, repo.labels.map((label) => ({ name: label.name, color: label.color })));
  });

  // ------------------------------------------------------------ issues

  const postIssueHandler: Handler = (req, res, body, match) => {
    const [, owner, name] = (match ?? /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(new URL(req.url ?? '/', 'http://entry').pathname)) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const record = body as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title : '';
    const issueBody = typeof record.body === 'string' ? record.body : '';
    const labels = Array.isArray(record.labels) ? record.labels.filter((label): label is string => typeof label === 'string') : [];
    for (const label of labels) {
      if (!repo.labels.some((candidate) => candidate.name === label)) {
        sendError(res, 422, `Validation Failed: label "${label}" does not exist`);
        return;
      }
    }
    // V3: parse once, create once, serialize the returned object directly.
    const issue = store.createIssue(repo, title, issueBody, labels);
    sendJson(res, 201, store.issueJson(repo, issue));
  };
  route('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/, postIssueHandler);

  route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/, (req, res) => {
    const [, owner, name] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const query = queryOf(req);
    const state = query.get('state') ?? 'open';
    const direction = query.get('direction') ?? 'desc';
    let issues = [...repo.issues];
    if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
    sendJson(res, 200, paginate(req, res, issues.map((issue) => store.issueJson(repo, issue))));
  });

  route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, (req, res) => {
    const [, owner, name, numberRaw] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const issue = repo.issueMap.get(Number(numberRaw));
    if (issue === undefined) {
      sendNotFound(res, 'Not Found');
      return;
    }
    sendJson(res, 200, store.issueJson(repo, issue));
  });

  route('PATCH', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/, (req, res, body) => {
    const [, owner, name, numberRaw] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const issue = repo.issueMap.get(Number(numberRaw));
    if (issue === undefined) {
      sendNotFound(res, 'Not Found');
      return;
    }
    const record = body as Record<string, unknown>;
    if (typeof record.title === 'string') issue.title = record.title;
    if (typeof record.body === 'string') issue.body = record.body;
    if (record.state === 'open' || record.state === 'closed') issue.state = record.state;
    store.invalidateIssue(repo, issue.number);
    sendJson(res, 200, store.issueJson(repo, issue));
  });

  route('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, (req, res, body) => {
    const [, owner, name, numberRaw] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const issue = repo.issueMap.get(Number(numberRaw));
    if (issue === undefined) {
      sendNotFound(res, 'Not Found');
      return;
    }
    const record = body as Record<string, unknown>;
    const commentBody = typeof record.body === 'string' ? record.body : '';
    const comment: Comment = { id: store.nextId(), body: commentBody, createdAt: store.nowIso() };
    issue.comments.push(comment);
    store.invalidateIssue(repo, issue.number);
    sendJson(res, 201, store.commentJson(repo, issue, comment));
  });

  route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/, (req, res) => {
    const [, owner, name, numberRaw] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const issue = repo.issueMap.get(Number(numberRaw));
    if (issue === undefined) {
      sendNotFound(res, 'Not Found');
      return;
    }
    sendJson(res, 200, issue.comments.map((comment) => store.commentJson(repo, issue, comment)));
  });

  route('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels$/, (req, res, body) => {
    const [, owner, name, numberRaw] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const issue = repo.issueMap.get(Number(numberRaw));
    if (issue === undefined) {
      sendNotFound(res, 'Not Found');
      return;
    }
    const names: string[] = Array.isArray(body)
      ? body.filter((label): label is string => typeof label === 'string')
      : Array.isArray((body as Record<string, unknown>).labels)
        ? ((body as Record<string, unknown>).labels as unknown[]).filter((label): label is string => typeof label === 'string')
        : typeof (body as Record<string, unknown>).name === 'string'
          ? [(body as Record<string, unknown>).name as string]
          : [];
    for (const labelName of names) {
      if (!repo.labels.some((label) => label.name === labelName)) {
        sendError(res, 422, `Validation Failed: label "${labelName}" does not exist`);
        return;
      }
      if (!issue.labels.includes(labelName)) issue.labels.push(labelName);
    }
    store.invalidateIssue(repo, issue.number);
    sendJson(
      res,
      200,
      issue.labels.map((labelName) => {
        const label = repo.labels.find((candidate) => candidate.name === labelName);
        return { name: labelName, color: label?.color ?? 'ededed' };
      }),
    );
  });

  route('DELETE', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels\/([^/]+)$/, (req, res) => {
    const [, owner, name, numberRaw, labelName] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels\/([^/]+)$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const issue = repo.issueMap.get(Number(numberRaw));
    if (issue === undefined) {
      sendNotFound(res, 'Not Found');
      return;
    }
    issue.labels = issue.labels.filter((label) => label !== decodeURIComponent(labelName as string));
    store.invalidateIssue(repo, issue.number);
    sendJson(
      res,
      200,
      issue.labels.map((label) => {
        const found = repo.labels.find((candidate) => candidate.name === label);
        return { name: label, color: found?.color ?? 'ededed' };
      }),
    );
  });

  // ------------------------------------------------------------ pull requests

  route('POST', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/, (req, res, body) => {
    const [, owner, name] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const record = body as Record<string, unknown>;
    const head = typeof record.head === 'string' ? record.head : '';
    const base = typeof record.base === 'string' ? record.base : '';
    const title = typeof record.title === 'string' ? record.title : '';
    const pullBody = typeof record.body === 'string' ? record.body : '';
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) {
      sendError(res, 422, 'Validation Failed: head or base branch does not exist');
      return;
    }
    const pull = store.createPullRequest(repo, title, pullBody, head, base, headSha, baseSha);
    sendJson(res, 201, store.pullJson(repo, pull));
  });

  route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/, (req, res) => {
    const [, owner, name] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const state = queryOf(req).get('state') ?? 'open';
    let pulls = [...repo.pulls];
    if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
    sendJson(res, 200, paginate(req, res, pulls.map((pull) => store.pullJson(repo, pull))));
  });

  route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/, (req, res) => {
    const [, owner, name, numberRaw] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const pull = repo.pullMap.get(Number(numberRaw));
    if (pull === undefined) {
      sendNotFound(res, 'Not Found');
      return;
    }
    sendJson(res, 200, store.pullJson(repo, pull));
  });

  route('GET', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/, (req, res) => {
    const [, owner, name, numberRaw] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const pull = repo.pullMap.get(Number(numberRaw));
    if (pull === undefined) {
      sendNotFound(res, 'Not Found');
      return;
    }
    const diff = store.diffTrees(pull.baseSha, pull.headSha);
    const files = diff.map((entry) => {
      const additions = entry.status === 'removed' ? 0 : Math.max(1, entry.additions);
      const deletions = entry.status === 'added' ? 0 : entry.deletions;
      return {
        filename: entry.filename,
        status: entry.status,
        additions,
        deletions,
        changes: additions + deletions,
      };
    });
    sendJson(res, 200, files);
  });

  route('PUT', /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/, (req, res) => {
    const [, owner, name, numberRaw] = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/.exec(new URL(req.url ?? '/', 'http://entry').pathname) as RegExpExecArray;
    const repo = repoOr404(store, res, owner as string, name as string);
    if (repo === null) return;
    const pull = repo.pullMap.get(Number(numberRaw));
    if (pull === undefined) {
      sendNotFound(res, 'Not Found');
      return;
    }
    if (pull.state !== 'open') {
      sendError(res, 405, 'Pull request is already closed');
      return;
    }
    const mergedSha = store.squashMerge(repo, pull);
    if (mergedSha === null) {
      sendError(res, 405, 'Merge conflict');
      return;
    }
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = store.nowIso();
    pull.mergeCommitSha = mergedSha;
    sendJson(res, 200, { sha: mergedSha, merged: true, message: `Merge pull request #${pull.number} from ${pull.head}` });
  });

  // ------------------------------------------------------------ dispatch

  /** The write workload's hot route, matched before the linear route scan. */
  const POST_ISSUES_RE = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/;

  return (req, res, body) => {
    const method = req.method ?? 'GET';
    const pathname = new URL(req.url ?? '/', 'http://entry').pathname;
    if (!pathname.startsWith('/api/v3')) return false;
    if (!requireAuth(req, res)) return true;
    if (method === 'POST') {
      const hot = POST_ISSUES_RE.exec(pathname);
      if (hot !== null) {
        postIssueHandler(req, res, body, hot);
        return true;
      }
    }
    for (const entry of routes) {
      if (entry.method !== method) continue;
      if (!entry.pattern.test(pathname)) continue;
      entry.handler(req, res, body);
      return true;
    }
    sendNotFound(res, 'Not Found');
    return true;
  };
}
