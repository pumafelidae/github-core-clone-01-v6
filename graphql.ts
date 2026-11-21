// GraphQL over POST /api/graphql: a hand-rolled parser (operations, variables,
// aliases, inline input objects/lists/enums/null, fragments, operation names) plus
// an executor for exactly the documents the suite sends — viewer, repository,
// __type introspection, node, issues/pull-request connections with cursor paging,
// and the createIssue/closeIssue/createPullRequest/mergePullRequest/addComment
// mutations. A JSON array body is a batch: one result per element, in order.
//
// Unknown fields fail with HTTP 200 and an `errors` array naming the field, the
// GraphQL way. An unknown repo is not an error: data.repository is null.
// Global ids are opaque base64url strings (Repository:<dbid>, Issue:<dbid>:<number>,
// PullRequest:<dbid>:<number>, IssueComment:<dbid>:<issue>:<commentId>, User:<dbid>)
// — never the plain database id or number.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { b64urlDecode, b64urlEncode, requireAuth, sendError, sendJson } from './util.ts';
import { type Issue, type PullRequest, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: string }
  | { kind: 'punct'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += source[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9.]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}()[]:!=$@&|.'.includes(ch)) {
      if (ch === '.' && source.slice(i, i + 3) === '...') {
        tokens.push({ kind: 'punct', value: '...' });
        i += 3;
        continue;
      }
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- AST

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: Array<{ name: string; value: ValueNode }>;
  readonly selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selection: SelectionNode[] };

interface OperationNode {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly variables: Array<{ name: string; defaultValue: ValueNode | null }>;
  readonly selection: SelectionNode[];
}

interface FragmentNode {
  readonly name: string;
  readonly typeCondition: string;
  readonly selection: SelectionNode[];
}

interface DocumentNode {
  readonly operations: OperationNode[];
  readonly fragments: Map<string, FragmentNode>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
  }

  private matchPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        const on = this.expectName();
        if (on !== 'on') throw new Error('expected "on" after a fragment name');
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selection = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selection });
        continue;
      }
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new Error('GraphQL document has no operation');
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek() as Token;
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value;
      this.next();
      const maybeName = this.peek();
      if (maybeName !== undefined && maybeName.kind === 'name') name = this.next().value;
    }
    const variables: OperationNode['variables'] = [];
    if (this.matchPunct('(')) {
      while (!this.matchPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.matchPunct('=')) defaultValue = this.parseValue(true);
        variables.push({ name: varName, defaultValue });
      }
    }
    this.skipDirectives();
    const selection = this.parseSelectionSet();
    return { kind, name, variables, selection };
  }

  private parseType(): void {
    if (this.matchPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.matchPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.matchPunct('}')) {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const next = this.peek();
        if (next !== undefined && next.kind === 'name' && next.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selection: this.parseSelectionSet() });
        } else if (next !== undefined && next.kind === 'name') {
          const name = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        } else {
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition: null, selection: this.parseSelectionSet() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    return selections;
  }

  private parseField(): FieldNode {
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.matchPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    let args: FieldNode['args'] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') args = this.parseArguments();
    this.skipDirectives();
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  private parseArguments(): FieldNode['args'] {
    this.expectPunct('(');
    const args: FieldNode['args'] = [];
    while (!this.matchPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    return args;
  }

  private parseValue(literalOnly: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (literalOnly) throw new Error('variable in a literal-only value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') {
      return token.value.includes('.') ? { kind: 'float', value: Number(token.value) } : { kind: 'int', value: Number(token.value) };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.matchPunct(']')) values.push(this.parseValue(literalOnly));
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.matchPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(literalOnly) });
      }
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

// ---------------------------------------------------------------- values + errors

class GraphQLError extends Error {}

function valueFromNode(node: ValueNode, variables: Map<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      if (!variables.has(node.name)) throw new GraphQLError(`Variable $${node.name} was not provided`);
      return variables.get(node.name);
    }
    case 'string':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => valueFromNode(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueFromNode(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema tables (for __type)

const TYPE_FIELDS: Record<string, string[]> = {
  Viewer: ['id', 'databaseId', 'login', 'name', 'email'],
  User: ['id', 'databaseId', 'login', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'private',
    'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'labels', 'comments', 'createdAt', 'updatedAt', 'url', 'repository'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid',
    'baseRefOid', 'merged', 'mergeable', 'mergedAt', 'mergeCommit', 'files', 'author', 'createdAt',
    'updatedAt', 'repository',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt'],
  Ref: ['name'],
  IssueConnection: ['totalCount', 'edges', 'nodes', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['totalCount', 'edges', 'nodes', 'pageInfo'],
  PullRequestEdge: ['node', 'cursor'],
  LabelConnection: ['totalCount', 'edges', 'nodes'],
  CommentConnection: ['totalCount', 'edges', 'nodes'],
  PullRequestChangedFileConnection: ['totalCount', 'edges', 'nodes'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
};

const TYPE_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

// ---------------------------------------------------------------- node values

interface NodeValue {
  readonly __type: string;
  readonly [key: string]: unknown;
}

function globalId(kind: string, parts: Array<string | number>): string {
  return b64urlEncode(`${kind}:${parts.join(':')}`);
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = b64urlDecode(id);
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function cursorFor(number: number): string {
  return b64urlEncode(`cursor:${number}`);
}

function numberAfterCursor(after: string | undefined): number | null {
  if (after === undefined) return null;
  try {
    const text = b64urlDecode(after);
    const match = /^cursor:(\d+)$/.exec(text);
    if (match !== null) return Number(match[1]);
  } catch {
    // Not a cursor we made; fall through.
  }
  const raw = Number(after);
  return Number.isFinite(raw) ? raw : null;
}

// ---------------------------------------------------------------- executor

export class GraphQLService {
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  private viewerNode(): NodeValue {
    return {
      __type: 'Viewer',
      login: this.store.viewerLogin,
      name: this.store.viewerName,
      email: this.store.viewerEmail,
      id: globalId('User', [this.store.viewerId]),
      databaseId: this.store.viewerId,
    };
  }

  private userNode(login: string, id: number): NodeValue {
    return { __type: 'User', login, name: login, email: '', id: globalId('User', [id]), databaseId: id };
  }

  private repoNode(repo: Repo): NodeValue {
    return {
      __type: 'Repository',
      __repo: repo,
      id: globalId('Repository', [repo.id]),
      databaseId: repo.id,
      name: repo.name,
      nameWithOwner: repo.fullName,
      owner: this.userNode(repo.owner, this.store.viewerId),
      defaultBranchRef: { __type: 'Ref', name: repo.defaultBranch },
      viewerPermission: 'ADMIN',
      hasIssuesEnabled: true,
      description: repo.description,
      private: repo.privateFlag,
      createdAt: repo.createdAt,
      updatedAt: repo.updatedAt,
    };
  }

  private issueNode(repo: Repo, issue: Issue): NodeValue {
    return {
      __type: 'Issue',
      __repo: repo,
      __issue: issue,
      id: globalId('Issue', [repo.id, issue.number]),
      databaseId: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
      author: this.userNode(this.store.viewerLogin, this.store.viewerId),
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    };
  }

  private pullNode(repo: Repo, pull: PullRequest): NodeValue {
    const headSha = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
    const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
    const mergeable = this.store.isMergeable(repo, pull);
    return {
      __type: 'PullRequest',
      __repo: repo,
      __pull: pull,
      id: globalId('PullRequest', [repo.id, pull.number]),
      databaseId: pull.id,
      number: pull.number,
      title: pull.title,
      body: pull.body,
      state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
      headRefName: pull.head,
      baseRefName: pull.base,
      headRefOid: headSha,
      baseRefOid: baseSha,
      merged: pull.merged,
      mergeable: mergeable === null ? 'UNKNOWN' : mergeable ? 'MERGEABLE' : 'CONFLICTING',
      mergedAt: pull.mergedAt,
      mergeCommit: pull.mergeCommitSha === null ? null : { __type: 'Commit', oid: pull.mergeCommitSha },
      createdAt: pull.createdAt,
      updatedAt: pull.updatedAt,
    };
  }

  private commentNode(repo: Repo, issue: Issue, comment: { id: number; body: string; createdAt: string }): NodeValue {
    return {
      __type: 'IssueComment',
      __repo: repo,
      __issue: issue,
      id: globalId('IssueComment', [repo.id, issue.number, comment.id]),
      databaseId: comment.id,
      body: comment.body,
      author: this.userNode(this.store.viewerLogin, this.store.viewerId),
      createdAt: comment.createdAt,
    };
  }

  /** Resolve a global id to the node it names, or null. */
  private nodeById(id: string): NodeValue | null {
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    const { kind, parts } = decoded;
    if (kind === 'Repository') {
      const repo = this.store.getRepoByDbId(Number(parts[0]));
      return repo === undefined ? null : this.repoNode(repo);
    }
    if (kind === 'Issue') {
      const repo = this.store.getRepoByDbId(Number(parts[0]));
      if (repo === undefined) return null;
      const issue = repo.issueMap.get(Number(parts[1]));
      return issue === undefined ? null : this.issueNode(repo, issue);
    }
    if (kind === 'PullRequest') {
      const repo = this.store.getRepoByDbId(Number(parts[0]));
      if (repo === undefined) return null;
      const pull = repo.pullMap.get(Number(parts[1]));
      return pull === undefined ? null : this.pullNode(repo, pull);
    }
    if (kind === 'IssueComment') {
      const repo = this.store.getRepoByDbId(Number(parts[0]));
      if (repo === undefined) return null;
      const issue = repo.issueMap.get(Number(parts[1]));
      if (issue === undefined) return null;
      const comment = issue.comments.find((candidate) => candidate.id === Number(parts[2]));
      return comment === undefined ? null : this.commentNode(repo, issue, comment);
    }
    if (kind === 'User') {
      if (Number(parts[0]) !== this.store.viewerId) return null;
      return this.viewerNode();
    }
    return null;
  }

  private connection<T extends NodeValue>(
    type: string,
    nodes: readonly T[],
    args: Record<string, unknown>,
    numberOf: (node: T) => number,
  ): NodeValue {
    const states = Array.isArray(args.states) ? (args.states as string[]) : null;
    let filtered = [...nodes];
    if (states !== null) {
      const wanted = new Set(states);
      filtered = filtered.filter((node) => wanted.has(String(node.state)));
    }
    // orderBy: {field: CREATED_AT, direction: ASC|DESC} (or a bare string). The
    // sort key is the number (creation order); a DESC page continues below the
    // cursor, an ASC page above it.
    const orderBy = args.orderBy as { field?: unknown; direction?: unknown } | string | undefined;
    let descending = false;
    if (typeof orderBy === 'string') descending = orderBy.toUpperCase().includes('DESC');
    else if (orderBy !== null && typeof orderBy === 'object') {
      descending = String(orderBy.direction ?? 'ASC').toUpperCase() === 'DESC';
    }
    const after = numberAfterCursor(typeof args.after === 'string' ? args.after : undefined);
    if (after !== null) {
      filtered = filtered.filter((node) => (descending ? numberOf(node) < after : numberOf(node) > after));
    }
    filtered.sort((a, b) => (descending ? numberOf(b) - numberOf(a) : numberOf(a) - numberOf(b)));
    const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : 1000;
    const page = filtered.slice(0, first);
    const edges = page.map((node) => ({ __type: `${type}Edge`, node, cursor: cursorFor(numberOf(node)) }));
    return {
      __type: `${type}Connection`,
      totalCount: filtered.length,
      edges,
      nodes: page,
      pageInfo: {
        __type: 'PageInfo',
        hasNextPage: filtered.length > page.length,
        hasPreviousPage: after !== null,
        startCursor: edges.length > 0 ? (edges[0] as { cursor: string }).cursor : null,
        endCursor: edges.length > 0 ? (edges[edges.length - 1] as { cursor: string }).cursor : null,
      },
    };
  }

  private issueConnection(repo: Repo, args: Record<string, unknown>): NodeValue {
    const nodes = [...repo.issues].sort((a, b) => a.number - b.number).map((issue) => this.issueNode(repo, issue));
    return this.connection('Issue', nodes, args, (node) => node.number as number);
  }

  private pullConnection(repo: Repo, args: Record<string, unknown>): NodeValue {
    const nodes = [...repo.pulls].sort((a, b) => a.number - b.number).map((pull) => this.pullNode(repo, pull));
    return this.connection('PullRequest', nodes, args, (node) => node.number as number);
  }

  private argsOf(field: FieldNode, variables: Map<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const arg of field.args) out[arg.name] = valueFromNode(arg.value, variables);
    return out;
  }

  /** Execute a selection set against a typed value. */
  private executeSelection(
    typeName: string,
    value: unknown,
    selections: readonly SelectionNode[],
    variables: Map<string, unknown>,
    doc: DocumentNode,
  ): Record<string, unknown> {
    if (value === null || value === undefined) return {};
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragmentSpread') {
        const fragment = doc.fragments.get(selection.name);
        if (fragment === undefined) throw new GraphQLError(`Unknown fragment "${selection.name}"`);
        if (fragment.typeCondition !== typeName && !this.typeMatches(fragment.typeCondition, typeName, value)) continue;
        Object.assign(out, this.executeSelection(typeName, value, fragment.selection, variables, doc));
        continue;
      }
      if (selection.kind === 'inlineFragment') {
        if (selection.typeCondition !== null && selection.typeCondition !== typeName && !this.typeMatches(selection.typeCondition, typeName, value)) {
          continue;
        }
        Object.assign(out, this.executeSelection(typeName, value, selection.selection, variables, doc));
        continue;
      }
      const field = selection.field;
      const key = field.alias ?? field.name;
      out[key] = this.executeField(typeName, value, field, variables, doc);
    }
    return out;
  }

  /** A fragment's type condition matches when the value's runtime type is that type. */
  private typeMatches(condition: string, parentType: string, value: unknown): boolean {
    if (condition === parentType) return true;
    if (typeof value === 'object' && value !== null && '__type' in value) {
      return (value as NodeValue).__type === condition;
    }
    return false;
  }

  private executeField(
    typeName: string,
    value: unknown,
    field: FieldNode,
    variables: Map<string, unknown>,
    doc: DocumentNode,
  ): unknown {
    const node = value as NodeValue;
    if (field.name === '__typename') return typeName;
    const args = this.argsOf(field, variables);

    // Meta fields on the Query root.
    if (typeName === 'Query') {
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        if (TYPE_ENUM_VALUES[name] !== undefined) {
          return {
            __type: '__Type',
            name,
            kind: 'ENUM',
            fields: null,
            enumValues: (TYPE_ENUM_VALUES[name] as string[]).map((enumName) => ({ __type: '__EnumValue', name: enumName })),
          };
        }
        if (TYPE_FIELDS[name] !== undefined) {
          return {
            __type: '__Type',
            name,
            kind: 'OBJECT',
            fields: (TYPE_FIELDS[name] as string[]).map((fieldName) => ({
              __type: '__Field',
              name: fieldName,
              type: { __type: '__Type', name: 'String', kind: 'SCALAR' },
            })),
            enumValues: null,
          };
        }
        return null;
      }
      if (field.name === '__schema') {
        return {
          __type: '__Schema',
          queryType: { __type: '__Type', name: 'Query', kind: 'OBJECT' },
          mutationType: { __type: '__Type', name: 'Mutation', kind: 'OBJECT' },
          types: Object.keys(TYPE_FIELDS).map((name) => ({ __type: '__Type', name, kind: 'OBJECT' })),
        };
      }
      if (field.name === 'viewer') {
        if (field.selection === null) throw new GraphQLError('Field "viewer" of type "Query" must have a selection of subfields');
        return this.executeSelection('Viewer', this.viewerNode(), field.selection, variables, doc);
      }
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = owner === this.store.viewerLogin ? this.store.getRepo(owner, name) : undefined;
        if (repo === undefined) return null;
        if (field.selection === null) throw new GraphQLError('Field "repository" of type "Query" must have a selection of subfields');
        return this.executeSelection('Repository', this.repoNode(repo), field.selection, variables, doc);
      }
      if (field.name === 'node') {
        const found = typeof args.id === 'string' ? this.nodeById(args.id) : null;
        if (found === null) return null;
        if (field.selection === null) throw new GraphQLError('Field "node" of type "Query" must have a selection of subfields');
        return this.executeSelection(found.__type, found, field.selection, variables, doc);
      }
      throw new GraphQLError(`Cannot query field "${field.name}" on type "Query".`);
    }

    // Mutation root.
    if (typeName === 'Mutation') {
      const payload = this.executeMutation(field, args, variables, doc);
      if (field.selection === null) return payload;
      const payloadType = field.name === 'createIssue' ? 'CreateIssuePayload'
        : field.name === 'closeIssue' ? 'CloseIssuePayload'
        : field.name === 'createPullRequest' ? 'CreatePullRequestPayload'
        : field.name === 'mergePullRequest' ? 'MergePullRequestPayload'
        : 'AddCommentPayload';
      return this.executeSelection(payloadType, payload, field.selection, variables, doc);
    }

    // __Type / __Field / __EnumValue introspection objects.
    if (typeName === '__Type' || typeName === '__Field' || typeName === '__EnumValue' || typeName === '__Schema') {
      const record = node as unknown as Record<string, unknown>;
      if (!(field.name in record)) throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
      const raw = record[field.name];
      if (Array.isArray(raw)) {
        if (field.selection === null) return raw;
        const elementType = typeName === '__Type' && field.name === 'fields' ? '__Field' : '__EnumValue';
        return raw.map((element) => this.executeSelection(elementType, element, field.selection as SelectionNode[], variables, doc));
      }
      if (raw !== null && typeof raw === 'object' && field.selection !== null) {
        return this.executeSelection('__Type', raw, field.selection, variables, doc);
      }
      return raw;
    }

    // Repository fields.
    if (typeName === 'Repository') {
      const repo = (node as NodeValue).__repo as Repo;
      switch (field.name) {
        case 'issue': {
          const issue = repo.issueMap.get(Number(args.number));
          if (issue === undefined) return null;
          if (field.selection === null) throw new GraphQLError('Field "issue" of type "Repository" must have a selection of subfields');
          return this.executeSelection('Issue', this.issueNode(repo, issue), field.selection, variables, doc);
        }
        case 'issues':
          if (field.selection === null) throw new GraphQLError('Field "issues" of type "Repository" must have a selection of subfields');
          return this.executeSelection('IssueConnection', this.issueConnection(repo, args), field.selection, variables, doc);
        case 'pullRequest': {
          const pull = repo.pullMap.get(Number(args.number));
          if (pull === undefined) return null;
          if (field.selection === null) throw new GraphQLError('Field "pullRequest" of type "Repository" must have a selection of subfields');
          return this.executeSelection('PullRequest', this.pullNode(repo, pull), field.selection, variables, doc);
        }
        case 'pullRequests':
          if (field.selection === null) throw new GraphQLError('Field "pullRequests" of type "Repository" must have a selection of subfields');
          return this.executeSelection('PullRequestConnection', this.pullConnection(repo, args), field.selection, variables, doc);
        case 'owner':
          if (field.selection === null) return node.owner;
          return this.executeSelection('User', node.owner, field.selection, variables, doc);
        case 'defaultBranchRef': {
          if (node.defaultBranchRef === null) return null;
          if (field.selection === null) return node.defaultBranchRef;
          return this.executeSelection('Ref', node.defaultBranchRef, field.selection, variables, doc);
        }
        default:
          break;
      }
    }

    // Issue fields.
    if (typeName === 'Issue') {
      const repo = (node as NodeValue).__repo as Repo;
      const issue = (node as NodeValue).__issue as Issue;
      switch (field.name) {
        case 'labels': {
          const labelNodes = issue.labels.map((labelName) => {
            const found = repo.labels.find((label) => label.name === labelName);
            return { __type: 'Label', name: labelName, color: found?.color ?? 'ededed' };
          });
          const connection: NodeValue = {
            __type: 'LabelConnection',
            totalCount: labelNodes.length,
            nodes: labelNodes,
            edges: labelNodes.map((labelNode) => ({ __type: 'LabelEdge', node: labelNode, cursor: cursorFor(0) })),
          };
          if (field.selection === null) return connection;
          return this.executeSelection('LabelConnection', connection, field.selection, variables, doc);
        }
        case 'comments': {
          const commentNodes = issue.comments.map((comment) => this.commentNode(repo, issue, comment));
          const connection: NodeValue = {
            __type: 'CommentConnection',
            totalCount: commentNodes.length,
            nodes: commentNodes,
            edges: commentNodes.map((commentNode) => ({ __type: 'CommentEdge', node: commentNode, cursor: cursorFor(commentNode.databaseId as number) })),
          };
          if (field.selection === null) return connection;
          return this.executeSelection('CommentConnection', connection, field.selection, variables, doc);
        }
        case 'author':
          if (field.selection === null) return node.author;
          return this.executeSelection('User', node.author, field.selection, variables, doc);
        case 'repository':
          if (field.selection === null) return this.repoNode(repo);
          return this.executeSelection('Repository', this.repoNode(repo), field.selection, variables, doc);
        default:
          break;
      }
    }

    // PullRequest fields.
    if (typeName === 'PullRequest') {
      const repo = (node as NodeValue).__repo as Repo;
      const pull = (node as NodeValue).__pull as PullRequest;
      switch (field.name) {
        case 'files': {
          const diff = this.store.diffTrees(pull.baseSha, pull.headSha);
          const fileNodes = diff.map((entry) => ({
            __type: 'PullRequestChangedFile',
            path: entry.filename,
            additions: entry.status === 'removed' ? 0 : Math.max(1, entry.additions),
            deletions: entry.status === 'added' ? 0 : entry.deletions,
          }));
          const connection: NodeValue = {
            __type: 'PullRequestChangedFileConnection',
            totalCount: fileNodes.length,
            nodes: fileNodes,
            edges: fileNodes.map((fileNode) => ({ __type: 'PullRequestChangedFileEdge', node: fileNode, cursor: cursorFor(0) })),
          };
          if (field.selection === null) return connection;
          return this.executeSelection('PullRequestChangedFileConnection', connection, field.selection, variables, doc);
        }
        case 'author':
          if (field.selection === null) return node.author ?? this.userNode(this.store.viewerLogin, this.store.viewerId);
          return this.executeSelection('User', node.author ?? this.userNode(this.store.viewerLogin, this.store.viewerId), field.selection, variables, doc);
        case 'mergeCommit': {
          if (node.mergeCommit === null) return null;
          if (field.selection === null) return node.mergeCommit;
          return this.executeSelection('Commit', node.mergeCommit, field.selection, variables, doc);
        }
        case 'repository':
          if (field.selection === null) return this.repoNode(repo);
          return this.executeSelection('Repository', this.repoNode(repo), field.selection, variables, doc);
        default:
          break;
      }
    }

    // Connection / edge / page-info objects.
    if (typeName.endsWith('Connection')) {
      const record = node as unknown as Record<string, unknown>;
      if (field.name === 'edges' && Array.isArray(record.edges)) {
        if (field.selection === null) return record.edges;
        const edgeType = typeName.replace(/Connection$/, 'Edge');
        return (record.edges as NodeValue[]).map((edge) => this.executeSelection(edgeType, edge, field.selection as SelectionNode[], variables, doc));
      }
      if (field.name === 'nodes' && Array.isArray(record.nodes)) {
        if (field.selection === null) return record.nodes;
        const nodeType = typeName.replace(/Connection$/, '');
        return (record.nodes as NodeValue[]).map((child) => this.executeSelection(nodeType, child, field.selection as SelectionNode[], variables, doc));
      }
      if (field.name === 'pageInfo' && record.pageInfo !== undefined) {
        if (field.selection === null) return record.pageInfo;
        return this.executeSelection('PageInfo', record.pageInfo, field.selection, variables, doc);
      }
      if (field.name in record) return record[field.name];
      throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
    }
    if (typeName.endsWith('Edge')) {
      if (field.name === 'node') {
        const child = (node as unknown as Record<string, unknown>).node as NodeValue;
        if (field.selection === null) return child;
        return this.executeSelection(child.__type, child, field.selection, variables, doc);
      }
      if (field.name === 'cursor') return (node as unknown as Record<string, unknown>).cursor ?? null;
      throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
    }

    // Plain scalar / object fields present on the node value.
    const record = node as unknown as Record<string, unknown>;
    if (field.name in record) {
      const raw = record[field.name];
      if (raw !== null && typeof raw === 'object' && field.selection !== null) {
        const childType = (raw as NodeValue).__type ?? 'Unknown';
        return this.executeSelection(childType, raw, field.selection, variables, doc);
      }
      if (field.selection !== null && raw !== null && typeof raw === 'object') {
        throw new GraphQLError(`Field "${field.name}" of type "${typeName}" must not have a selection of subfields`);
      }
      return raw;
    }
    throw new GraphQLError(`Cannot query field "${field.name}" on type "${typeName}".`);
  }

  private executeMutation(
    field: FieldNode,
    args: Record<string, unknown>,
    _variables: Map<string, unknown>,
    _doc: DocumentNode,
  ): NodeValue {
    const input = (args.input ?? {}) as Record<string, unknown>;
    const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
    if (field.name === 'createIssue') {
      const repo = typeof input.repositoryId === 'string' ? this.nodeById(input.repositoryId) : null;
      if (repo === null || repo.__type !== 'Repository') throw new GraphQLError('createIssue: repositoryId does not name a repository');
      const target = (repo as NodeValue).__repo as Repo;
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = this.store.createIssue(target, title, body, []);
      return { __type: 'CreateIssuePayload', issue: this.issueNode(target, issue), clientMutationId };
    }
    if (field.name === 'closeIssue') {
      const found = typeof input.issueId === 'string' ? this.nodeById(input.issueId) : null;
      if (found === null || found.__type !== 'Issue') throw new GraphQLError('closeIssue: issueId does not name an issue');
      const repo = (found as NodeValue).__repo as Repo;
      const issue = (found as NodeValue).__issue as Issue;
      issue.state = 'closed';
      this.store.invalidateIssue(repo, issue.number);
      return { __type: 'CloseIssuePayload', issue: this.issueNode(repo, issue), clientMutationId };
    }
    if (field.name === 'createPullRequest') {
      const repo = typeof input.repositoryId === 'string' ? this.nodeById(input.repositoryId) : null;
      if (repo === null || repo.__type !== 'Repository') throw new GraphQLError('createPullRequest: repositoryId does not name a repository');
      const target = (repo as NodeValue).__repo as Repo;
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (target.refs.get(`refs/heads/${head}`) === undefined || target.refs.get(`refs/heads/${base}`) === undefined) {
        throw new GraphQLError('createPullRequest: head or base branch does not exist');
      }
      const pull = this.store.createPullRequest(
        target,
        title,
        body,
        head,
        base,
        target.refs.get(`refs/heads/${head}`) as string,
        target.refs.get(`refs/heads/${base}`) as string,
      );
      return { __type: 'CreatePullRequestPayload', pullRequest: this.pullNode(target, pull), clientMutationId };
    }
    if (field.name === 'mergePullRequest') {
      const found = typeof input.pullRequestId === 'string' ? this.nodeById(input.pullRequestId) : null;
      if (found === null || found.__type !== 'PullRequest') throw new GraphQLError('mergePullRequest: pullRequestId does not name a pull request');
      const repo = (found as NodeValue).__repo as Repo;
      const pull = (found as NodeValue).__pull as PullRequest;
      if (pull.state !== 'open') throw new GraphQLError('mergePullRequest: pull request is not open');
      const mergedSha = this.store.squashMerge(repo, pull);
      if (mergedSha === null) throw new GraphQLError('mergePullRequest: merge conflict');
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = this.store.nowIso();
      pull.mergeCommitSha = mergedSha;
      return { __type: 'MergePullRequestPayload', pullRequest: this.pullNode(repo, pull), clientMutationId };
    }
    if (field.name === 'addComment') {
      const found = typeof input.subjectId === 'string' ? this.nodeById(input.subjectId) : null;
      if (found === null || found.__type !== 'Issue') throw new GraphQLError('addComment: subjectId does not name an issue');
      const repo = (found as NodeValue).__repo as Repo;
      const issue = (found as NodeValue).__issue as Issue;
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: this.store.nextId(), body, createdAt: this.store.nowIso() };
      issue.comments.push(comment);
      this.store.invalidateIssue(repo, issue.number);
      const commentNode = this.commentNode(repo, issue, comment);
      return {
        __type: 'AddCommentPayload',
        commentEdge: { __type: 'CommentEdge', node: commentNode, cursor: cursorFor(comment.id) },
        subject: found,
        clientMutationId,
      };
    }
    throw new GraphQLError(`Cannot query field "${field.name}" on type "Mutation".`);
  }

  /** Execute one request body ({query, variables, operationName}). */
  executeOne(request: { query?: unknown; variables?: unknown; operationName?: unknown }): Record<string, unknown> {
    try {
      if (typeof request.query !== 'string' || request.query.trim() === '') {
        return { errors: [{ message: 'GraphQL query is required' }] };
      }
      const doc = new Parser(tokenize(request.query)).parseDocument();
      let operation: OperationNode | undefined;
      if (typeof request.operationName === 'string') {
        operation = doc.operations.find((candidate) => candidate.name === request.operationName);
        if (operation === undefined) return { errors: [{ message: `Unknown operation named "${request.operationName}"` }] };
      } else {
        operation = doc.operations[0];
      }
      const variables = new Map<string, unknown>();
      const provided = (request.variables ?? {}) as Record<string, unknown>;
      for (const variable of operation.variables) {
        if (Object.prototype.hasOwnProperty.call(provided, variable.name)) {
          variables.set(variable.name, provided[variable.name]);
        } else if (variable.defaultValue !== null) {
          variables.set(variable.name, valueFromNode(variable.defaultValue, new Map()));
        }
      }
      const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
      const data = this.executeSelection(rootType, {}, operation.selection, variables, doc);
      return { data };
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL execution failed' }] };
    }
  }
}

// ---------------------------------------------------------------- HTTP handler

export function createGraphQLHandler(store: Store): (req: IncomingMessage, res: ServerResponse, body: Buffer) => boolean {
  const service = new GraphQLService(store);
  return (req, res, body) => {
    const pathname = new URL(req.url ?? '/', 'http://entry').pathname;
    if (pathname !== '/api/graphql') return false;
    if (req.method !== 'POST') {
      sendError(res, 405, 'Method not allowed');
      return true;
    }
    if (!requireAuth(req, res)) return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      sendError(res, 400, 'Request body is not valid JSON');
      return true;
    }
    if (Array.isArray(parsed)) {
      sendJson(res, 200, parsed.map((entry) => service.executeOne(entry as { query?: unknown; variables?: unknown; operationName?: unknown })));
      return true;
    }
    sendJson(res, 200, service.executeOne(parsed as { query?: unknown; variables?: unknown; operationName?: unknown }));
    return true;
  };
}
