// The forge's in-memory store: git objects, repositories, issues, pull requests,
// labels and comments, plus the V1 single-issue GET cache and the V2 commit cache.
// Determinism: commit timestamps come from a counter over a fixed epoch (never the
// wall clock); every id comes from a counter. No network, no wall clock reads.

import { SCENARIO_EPOCH_SEC, buildScenario } from './wire.ts';
import { ZERO_OID, b64decode, b64encode, hashObject, isOid } from './util.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  /** Author epoch seconds (0 when the commit carries no parseable timestamp). */
  readonly timestampSec: number;
}

export interface TagView {
  readonly object: string;
  readonly type: ObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if ending in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  // The commit builder appends one trailing newline; the stored message keeps
  // it, but readers (REST commit.message) see it trimmed exactly once.
  const rawMessage = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  const message = rawMessage.endsWith('\n') ? rawMessage.slice(0, -1) : rawMessage;
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let timestampSec = 0;
  const epochOf = (line: string): number => {
    const match = / (\d+) [+-]\d{4}$/.exec(line);
    return match === null ? 0 : Number(match[1]);
  };
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') {
      author = value;
      timestampSec = epochOf(value);
    } else if (key === 'committer') {
      committer = value;
      if (timestampSec === 0) timestampSec = epochOf(value);
    }
  }
  return { tree, parents, author, committer, message, timestampSec };
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  return {
    object: headers.get('object') ?? '',
    type: type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** The well-known empty tree object id. */
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  /** Label names; colours live on the repo's label definitions. */
  labels: string[];
  comments: Comment[];
  createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

export class Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  privateFlag: boolean;
  readonly defaultBranch = 'main';
  readonly refs = new Map<string, string>();
  refVersion = 0;
  /** Shared issue + pull-request numbering, as on GitHub. */
  counter = 0;
  readonly issues: Issue[] = [];
  /** O(1) issue lookup by number (the V1 read path's map). */
  readonly issueMap = new Map<number, Issue>();
  readonly pulls: PullRequest[] = [];
  readonly pullMap = new Map<number, PullRequest>();
  readonly labels: Label[] = [];
  readonly createdAt: string;
  updatedAt: string;

  constructor(id: number, owner: string, name: string, description: string, privateFlag: boolean, createdAt: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.privateFlag = privateFlag;
    this.createdAt = createdAt;
    this.updatedAt = createdAt;
  }

  /** Set a ref; every ref mutation bumps refVersion (the V2 ad-cache key). */
  setRef(ref: string, oid: string): void {
    this.refs.set(ref, oid);
    this.refVersion += 1;
  }

  /** Delete a ref; every ref mutation bumps refVersion. */
  deleteRef(ref: string): boolean {
    const removed = this.refs.delete(ref);
    if (removed) this.refVersion += 1;
    return removed;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }
}

export interface FlattenedCommit {
  /** path -> blob oid, every file in the commit's tree (gitlinks skipped). */
  readonly flat: Map<string, string>;
  /** [commit, ...trees DFS pre-order, ...blobs in path order], de-duplicated. */
  readonly objects: string[];
}

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  /** V2 commit cache: flattenCommit results (objects are immutable, never invalidated). */
  readonly commitCache = new Map<string, FlattenedCommit>();
  /** V1 single-issue GET cache: serialized issue bodies by `owner/repo#number`. */
  readonly issueCache = new Map<string, Buffer>();
  readonly viewerLogin: string;
  readonly viewerName: string;
  readonly viewerEmail: string;
  readonly viewerId: number;
  private dbId = 0;
  private clock = 0;

  constructor() {
    const scenario = buildScenario();
    this.viewerLogin = scenario.viewer.login;
    this.viewerName = scenario.viewer.name;
    this.viewerEmail = scenario.viewer.email;
    this.viewerId = scenario.viewer.id;
    this.putObject('tree', Buffer.alloc(0));
  }

  /** A fresh database id, from a counter. */
  nextId(): number {
    this.dbId += 1;
    return this.dbId;
  }

  /** The next deterministic timestamp (seconds since epoch), from the fixed-epoch counter. */
  nextTimestampSec(): number {
    const sec = SCENARIO_EPOCH_SEC + this.clock * 60;
    this.clock += 1;
    return sec;
  }

  /** The next deterministic ISO timestamp. */
  nowIso(): string {
    return new Date(this.nextTimestampSec() * 1000).toISOString();
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoByDbId(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  /** Repositories owned by the viewer, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === this.viewerLogin) out.push(repo);
    return out;
  }

  createRepo(name: string, privateFlag: boolean, description: string): Repo {
    const createdAt = this.nowIso();
    const repo = new Repo(this.nextId(), this.viewerLogin, name, description, privateFlag, createdAt);
    this.repos.set(this.repoKey(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.getRepo(owner, name);
    if (repo === undefined) return false;
    this.invalidateRepoIssues(repo);
    return this.repos.delete(this.repoKey(owner, name));
  }

  // ---------------------------------------------------------------- objects

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  hasObject(oid: string): boolean {
    return this.objects.has(oid);
  }

  /** Store an object, returning its id (no-op when already present). */
  putObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Store an object whose id the caller already computed (readPack hashes once). */
  putObjectKnown(oid: string, type: ObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }

  parseCommitObject(oid: string): CommitView | null {
    const object = this.getObject(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /** Build a commit object (author/committer = the viewer) and store it. */
  createCommit(tree: string, parents: readonly string[], message: string): string {
    const timestamp = this.nextTimestampSec();
    const who = `${this.viewerName} <${this.viewerEmail}> ${timestamp} +0000`;
    const lines = [`tree ${tree}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${who}`, `committer ${who}`, '');
    const text = message.endsWith('\n') ? message : `${message}\n`;
    return this.putObject('commit', Buffer.from(`${lines.join('\n')}\n${text}`, 'utf8'));
  }

  // ---------------------------------------------------------------- trees

  /** Flatten a tree to path -> {oid, mode}, recursively (gitlinks skipped). */
  flattenTree(treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = this.getObject(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode === '160000') continue;
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /**
   * V2 commit cache: a commit's flattened tree and its object list. Objects are immutable,
   * so this cache never needs invalidation. Cap 8192; when full, compute but do not cache.
   */
  flattenCommit(commitSha: string): FlattenedCommit {
    const cached = this.commitCache.get(commitSha);
    if (cached !== undefined) return cached;
    const commit = this.parseCommitObject(commitSha);
    if (commit === null) throw new Error(`flattenCommit: ${commitSha} is not a commit`);
    const flat = new Map<string, string>();
    const trees: string[] = [];
    const seenTrees = new Set<string>();
    const blobs: Array<[string, string]> = [];
    const walk = (treeOid: string, prefix: string): void => {
      if (seenTrees.has(treeOid)) return;
      seenTrees.add(treeOid);
      trees.push(treeOid);
      const object = this.getObject(treeOid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode === '160000') continue;
        else {
          flat.set(path, entry.oid);
          blobs.push([path, entry.oid]);
        }
      }
    };
    walk(commit.tree, '');
    blobs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const objects: string[] = [commitSha];
    const seenObjects = new Set<string>([commitSha]);
    for (const oid of [...trees, ...blobs.map(([, oid]) => oid)]) {
      if (seenObjects.has(oid)) continue;
      seenObjects.add(oid);
      objects.push(oid);
    }
    const result: FlattenedCommit = { flat, objects };
    if (this.commitCache.size < 8192) this.commitCache.set(commitSha, result);
    return result;
  }

  // ---------------------------------------------------------------- ancestry

  /** True when `ancestor` is reachable from `descendant` (commit parents, tag targets). */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = this.getObject(oid);
      if (object === undefined) continue;
      if (object.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) stack.push(parent);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return false;
  }

  /** A common ancestor of two commits (the first found walking from `b` into `a`'s closure). */
  mergeBase(a: string, b: string): string | null {
    const ancestorsA = new Set<string>();
    const stackA: string[] = [a];
    while (stackA.length > 0) {
      const oid = stackA.pop() as string;
      if (ancestorsA.has(oid)) continue;
      ancestorsA.add(oid);
      const commit = this.parseCommitObject(oid);
      if (commit !== null) for (const parent of commit.parents) stackA.push(parent);
    }
    const stackB: string[] = [b];
    const seenB = new Set<string>();
    while (stackB.length > 0) {
      const oid = stackB.pop() as string;
      if (ancestorsA.has(oid)) return oid;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const commit = this.parseCommitObject(oid);
      if (commit !== null) for (const parent of commit.parents) stackB.push(parent);
    }
    return null;
  }

  /** Resolve a ref name or oid to a commit oid, or null. */
  resolveToCommit(repo: Repo, ref: string): string | null {
    let oid: string | undefined;
    if (isOid(ref)) oid = ref;
    else oid = repo.refs.get(ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);
    if (oid === undefined) return null;
    const object = this.getObject(oid);
    if (object === undefined) return null;
    if (object.type === 'commit') return oid;
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = this.getObject(target);
      return targetObject !== undefined && targetObject.type === 'commit' ? target : null;
    }
    return null;
  }

  // ---------------------------------------------------------------- contents commits

  /** Recursively set/delete one path in a tree; returns the new tree oid (null when empty). */
  updateTree(treeOid: string | null, segments: readonly string[], blobOid: string | null): string | null {
    const entries = new Map<string, TreeEntry>();
    if (treeOid !== null) {
      const object = this.getObject(treeOid);
      if (object !== undefined && object.type === 'tree') {
        for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
      }
    }
    const [head, ...rest] = segments as [string, ...string[]];
    if (rest.length === 0) {
      if (blobOid !== null) entries.set(head, { mode: '100644', name: head, oid: blobOid });
      else entries.delete(head);
    } else {
      const child = entries.get(head);
      const childOid = child !== undefined && child.mode === '40000' ? child.oid : null;
      const next = this.updateTree(childOid, rest, blobOid);
      if (next !== null) entries.set(head, { mode: '40000', name: head, oid: next });
      else entries.delete(head);
    }
    if (entries.size === 0) return null;
    return this.putObject('tree', buildTree([...entries.values()]));
  }

  /**
   * Commit one contents change on a branch: replace (or delete) `path`, create the commit,
   * move the branch. Returns the commit and (for writes) the blob oid.
   */
  commitContents(repo: Repo, branch: string, path: string, content: Buffer | null, message: string): { commitSha: string; contentSha: string | null } {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const baseTree = tip === undefined ? null : (this.parseCommitObject(tip)?.tree ?? null);
    const blobOid = content === null ? null : this.putObject('blob', content);
    const segments = path.split('/').filter((part) => part !== '');
    const nextTree = this.updateTree(baseTree, segments, blobOid) ?? EMPTY_TREE_OID;
    const commitSha = this.createCommit(nextTree, tip === undefined ? [] : [tip], message);
    repo.setRef(`refs/heads/${branch}`, commitSha);
    return { commitSha, contentSha: blobOid };
  }

  // ---------------------------------------------------------------- diff / merge

  /** A line count for additions/deletions accounting. */
  static lineCount(text: string): number {
    if (text === '') return 0;
    const parts = text.split('\n');
    return text.endsWith('\n') ? parts.length - 1 : parts.length;
  }

  /** The changed files between two trees (null tree = empty). */
  /**
   * Diff two trees (or the trees of two commits) into per-file change records.
   * A commit oid is resolved to its tree first, so callers may pass commit shas.
   */
  diffTrees(baseTree: string | null, headTree: string | null): PullFile[] {
    const resolve = (oid: string | null): Map<string, { oid: string; mode: string }> => {
      if (oid === null) return new Map();
      const object = this.getObject(oid);
      if (object === undefined) return new Map();
      if (object.type === 'commit') return this.flattenTree(parseCommit(object.data).tree);
      if (object.type === 'tree') return this.flattenTree(oid);
      return new Map();
    };
    const base = resolve(baseTree);
    const head = resolve(headTree);
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const out: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b !== undefined && h === undefined) {
        const deletions = Store.lineCount(this.getObject(b.oid)?.data.toString('utf8') ?? '');
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b === undefined && h !== undefined) {
        const additions = Store.lineCount(this.getObject(h.oid)?.data.toString('utf8') ?? '');
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
        const additions = Store.lineCount(this.getObject(h.oid)?.data.toString('utf8') ?? '');
        const deletions = Store.lineCount(this.getObject(b.oid)?.data.toString('utf8') ?? '');
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  /** Whether a pull request merges cleanly onto its base branch's current tip. */
  isMergeable(repo: Repo, pr: PullRequest): boolean {
    if (pr.merged) return false;
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    if (baseTip === undefined) return false;
    const base = this.mergeBase(baseTip, pr.headSha);
    if (base === null) return true;
    const baseFlat = this.flattenCommit(base).flat;
    const headFlat = this.flattenCommit(pr.headSha).flat;
    const tipFlat = this.flattenCommit(baseTip).flat;
    const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...tipFlat.keys()]);
    for (const path of paths) {
      const m = baseFlat.get(path);
      const h = headFlat.get(path);
      const t = tipFlat.get(path);
      const headChanged = h !== m;
      const tipChanged = t !== m;
      if (headChanged && tipChanged && h !== t) return false;
    }
    return true;
  }

  /** The squash-merge commit for a pull request; null when conflicted. */
  squashMerge(repo: Repo, pr: PullRequest): string | null {
    if (!this.isMergeable(repo, pr)) return null;
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    if (baseTip === undefined) return null;
    const base = this.mergeBase(baseTip, pr.headSha);
    const baseTree = this.parseCommitObject(baseTip)?.tree ?? null;
    const mergedFlat = new Map<string, string>();
    if (baseTree !== null) {
      for (const [path, entry] of this.flattenTree(baseTree)) mergedFlat.set(path, entry.oid);
    }
    if (base !== null) {
      const baseFlat = this.flattenCommit(base).flat;
      const headFlat = this.flattenCommit(pr.headSha).flat;
      const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
      for (const path of paths) {
        const m = baseFlat.get(path);
        const h = headFlat.get(path);
        if (h !== m) {
          if (h === undefined) mergedFlat.delete(path);
          else mergedFlat.set(path, h);
        }
      }
    } else {
      for (const [path, oid] of this.flattenCommit(pr.headSha).flat) mergedFlat.set(path, oid);
    }
    // Rebuild the tree from the flat map, bottom-up.
    const buildFromFlat = (flat: Map<string, string>): string => {
      const buildLevel = (prefix: string): string | null => {
        const entries = new Map<string, TreeEntry>();
        const childDirs = new Set<string>();
        for (const [path, oid] of flat) {
          if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
          const rest = prefix === '' ? path : path.slice(prefix.length + 1);
          const slash = rest.indexOf('/');
          if (slash < 0) entries.set(rest, { mode: '100644', name: rest, oid });
          else childDirs.add(rest.slice(0, slash));
        }
        for (const dir of childDirs) {
          const child = buildLevel(prefix === '' ? dir : `${prefix}/${dir}`);
          if (child !== null) entries.set(dir, { mode: '40000', name: dir, oid: child });
        }
        if (entries.size === 0) return null;
        return this.putObject('tree', buildTree([...entries.values()]));
      };
      return buildLevel('') ?? EMPTY_TREE_OID;
    };
    const tree = buildFromFlat(mergedFlat);
    const commitSha = this.createCommit(tree, [baseTip], `Merge pull request #${pr.number} from ${pr.head}\n\n${pr.title}`);
    repo.setRef(`refs/heads/${pr.base}`, commitSha);
    return commitSha;
  }

  // ---------------------------------------------------------------- issues (V1 cache)

  cacheKey(repo: Repo, number: number): string {
    return `${repo.owner}/${repo.name}#${number}`;
  }

  cacheIssue(repo: Repo, number: number, body: Record<string, unknown>): void {
    this.issueCache.set(this.cacheKey(repo, number), Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'));
  }

  invalidateIssue(repo: Repo, number: number): void {
    this.issueCache.delete(this.cacheKey(repo, number));
  }

  invalidateRepoIssues(repo: Repo): void {
    const prefix = `${repo.owner}/${repo.name}#`;
    for (const key of [...this.issueCache.keys()]) {
      if (key.startsWith(prefix)) this.issueCache.delete(key);
    }
  }

  /**
   * V3 issue-creation fast path: number from the shared counter, stable id precomputed once,
   * O(1) insert into both the array and the map. Returns the issue; the handler serializes
   * it directly from the returned object.
   */
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.counter + 1;
    repo.counter = number;
    const now = this.nowIso();
    const issue: Issue = {
      id: this.nextId(),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.push(issue);
    repo.issueMap.set(number, issue);
    return issue;
  }

  createPullRequest(repo: Repo, title: string, body: string, head: string, base: string, headSha: string, baseSha: string): PullRequest {
    const number = repo.counter + 1;
    repo.counter = number;
    const now = this.nowIso();
    const pr: PullRequest = {
      id: this.nextId(),
      number,
      title,
      body,
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.push(pr);
    repo.pullMap.set(number, pr);
    return pr;
  }

  // ---------------------------------------------------------------- serializers

  /** The one issue serializer: the fast path and the REST path share it byte for byte. */
  issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
    return {
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels: issue.labels.map((labelName) => {
        const found = repo.labels.find((label) => label.name === labelName);
        return { name: labelName, color: found?.color ?? 'ededed' };
      }),
      user: { login: this.viewerLogin, id: this.viewerId },
      created_at: issue.createdAt,
      updated_at: issue.updatedAt,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
      comments: issue.comments.length,
      comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
      locked: false,
    };
  }

  repoJson(repo: Repo): Record<string, unknown> {
    return {
      id: repo.id,
      name: repo.name,
      full_name: repo.fullName,
      private: repo.privateFlag,
      description: repo.description,
      default_branch: repo.defaultBranch,
      owner: { login: repo.owner, id: this.viewerId },
      html_url: `https://example.invalid/${repo.fullName}`,
      url: `/api/v3/repos/${repo.fullName}`,
      clone_url: `https://example.invalid/${repo.fullName}.git`,
      git_url: `git://example.invalid/${repo.fullName}.git`,
      ssh_url: `git@example.invalid:${repo.fullName}.git`,
      created_at: repo.createdAt,
      updated_at: repo.updatedAt,
      pushed_at: repo.updatedAt,
      has_issues: true,
      has_projects: true,
      has_wiki: true,
      forks_count: 0,
      stargazers_count: 0,
      watchers_count: 0,
      open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    };
  }

  pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
    const headSha = repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha;
    const baseSha = repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha;
    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.merged ? 'closed' : pr.state,
      head: { ref: pr.head, sha: headSha, label: `${repo.owner}:${pr.head}` },
      base: { ref: pr.base, sha: baseSha, label: `${repo.owner}:${pr.base}` },
      merged: pr.merged,
      merged_at: pr.mergedAt,
      merge_commit_sha: pr.mergeCommitSha,
      mergeable: this.isMergeable(repo, pr),
      user: { login: this.viewerLogin, id: this.viewerId },
      created_at: pr.createdAt,
      updated_at: pr.updatedAt,
      url: `/api/v3/repos/${repo.fullName}/pulls/${pr.number}`,
      html_url: `https://example.invalid/${repo.fullName}/pull/${pr.number}`,
    };
  }

  commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
    return {
      id: comment.id,
      body: comment.body,
      user: { login: this.viewerLogin, id: this.viewerId },
      created_at: comment.createdAt,
      updated_at: comment.updatedAt,
      url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments/${comment.id}`,
      html_url: `https://example.invalid/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    };
  }
}

export { b64decode, b64encode, ZERO_OID };
