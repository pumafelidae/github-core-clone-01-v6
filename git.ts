// git smart HTTP: pkt-line codec, packfile read/write, protocol v0/v2 handlers,
// receive-pack, and the caches:
//   V2 commit cache (in the store) + fetch cache + ref-advertisement cache,
//   V3 single-pass pack parse + O(1) fast-forward,
//   V5 precomputed full v2 fetch response for the canonical shallow clone.
//
// The one V5 change: a precomputed response Buffer for the canonical clone fetch
// (wants=[default-branch tip], haves=[], shallowIn=[], depth=1), built lazily on the
// first matching fetch after a tip change — never on the push path — invalidated by
// refVersion + tip. The response framing lives in one buildFetchResponse helper
// used by both the cached and the live path, so the bytes cannot drift.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTag, parseTree, type ObjectType, type Repo, type Store } from './store.ts';
import {
  PKT_FLUSH,
  decodePktLines,
  hashObject,
  isOid,
  pktLine,
  pktLines,
  sendBytes,
  sendError,
  sendNotFound,
  ZERO_OID,
} from './util.ts';

const AGENT = 'forge/1.0';

/** The v2 capability advertisement, identical for every repo: built once. */
const V2_CAPABILITIES: readonly string[] = Object.freeze([
  'version 2',
  `agent=${AGENT}`,
  'ls-refs=unborn',
  'fetch=shallow wait-for-done filter',
  'server-option',
  'object-format=sha1',
]);

export interface FetchSelection {
  readonly pack: Buffer;
  readonly shallow: string[];
  readonly unshallow: string[];
}

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjectType;
  resolved?: Buffer;
  oid?: string;
}

const TYPE_CODE: Readonly<Record<ObjectType, number>> = Object.freeze({ commit: 1, tree: 2, blob: 3, tag: 4 });
const CODE_TYPE: Readonly<Record<number, ObjectType>> = Object.freeze({ 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' });

// ---------------------------------------------------------------- packfile write

/** Encode one object's pack header: the type/size varint git's pack format uses. */
function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from plain objects (no deltas). Objects are de-duplicated by id:
 * a pack whose declared count exceeds its unique objects fails the suite's integrity
 * check. The trailer is SHA-1 over everything before it.
 */
export function writePack(objects: Iterable<{ type: ObjectType; data: Buffer }>, store: Store): Buffer {
  const seen = new Set<string>();
  const list: Array<{ type: ObjectType; data: Buffer }> = [];
  for (const object of objects) {
    const oid = hashObject(object.type, object.data);
    if (seen.has(oid)) continue;
    seen.add(oid);
    list.push(object);
  }
  void store;
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- delta application

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ---------------------------------------------------------------- packfile read (V3 single-pass)

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++] as number;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past it. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/**
 * V3 single-pass pack parse: verify the header and trailer, walk the entries once,
 * inflate exactly one zlib stream per entry, resolve deltas recursively with
 * memoization, and hash each object exactly once from its inflated bytes.
 */
export function readPack(pack: Buffer, store: Store): { ok: true; objects: Map<string, { type: ObjectType; data: Buffer }> } {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex') as string;
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawPackEntry[] = [];
  const byOffset = new Map<number, RawPackEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawPackEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, { type: ObjectType; data: Buffer }>();
  const resolvedByOid = new Map<string, RawPackEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawPackEntry): { type: ObjectType; data: Buffer; oid: string } => {
    if (entry.resolved !== undefined && entry.resolvedType !== undefined && entry.oid !== undefined) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry !== undefined) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = store.getObject(wanted);
        if (external === undefined) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the store`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as ObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { ok: true, objects };
}

// ---------------------------------------------------------------- sideband framing

/** Split pack bytes into sideband band-1 pkt-lines (payload <= 65516 bytes each). */
export function sidebandPackets(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) {
    // An empty pack still rides one (empty) band-1 packet, so the section is never bare.
    parts.push(pktLine(Buffer.from([1])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- the service

interface CloneCacheEntry {
  readonly tip: string;
  readonly refVersion: number;
  readonly body: Buffer;
}

export class GitService {
  readonly store: Store;
  /** V2 fetch cache: pack + shallow info by the full request key (cap 256, never evict). */
  readonly fetchCache = new Map<string, FetchSelection>();
  /** V2 ref-advertisement cache (cap 1024; when full, compute but do not cache). */
  readonly adCache = new Map<string, Buffer>();
  /** V5 precomputed full v2 fetch response for the canonical shallow clone. */
  readonly cloneResponseCache = new Map<string, CloneCacheEntry>();
  /** The v2 capability advertisement, identical for every repo. */
  private readonly v2Advertisement: Buffer;

  constructor(store: Store) {
    this.store = store;
    this.v2Advertisement = Buffer.concat([
      pktLine('# service=git-upload-pack\n'),
      PKT_FLUSH,
      pktLines([...V2_CAPABILITIES.map((cap) => `${cap}\n`), 'flush']),
    ]);
  }

  // ------------------------------------------------------------ fetch selection

  /**
   * Every object reachable from `roots` (commit -> tree + parents, tag -> target).
   * Commits in `stopAt` are leaves: their own tree and blobs are included, but
   * their parents are not — a shallow clone holds the boundary commit, not its
   * history, so a deepen must still deliver the parents.
   */
  private reachableObjects(roots: Iterable<string>, stopAt: ReadonlySet<string> = new Set()): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) if (isOid(root)) queue.push(root);
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const object = this.store.getObject(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!stopAt.has(oid)) {
          for (const parent of commit.parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode === '160000') continue;
          queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /**
   * V2 fetch selection: BFS from the wants, subtracting the haves' closures, stopping
   * at the incoming shallow edge; boundary commits become `shallow` lines, shallow-in
   * commits that gain depth become `unshallow` lines; tag wants contribute their tag
   * object; object order is tag objects first, then per want-commit in BFS order the
   * commit's flattenCommit objects. The cache key holds everything that determines
   * the bytes.
   */
  fetchSelection(wants: readonly string[], haves: readonly string[], shallowIn: readonly string[], depth: number | undefined): FetchSelection {
    const key = JSON.stringify({ w: wants, h: [...haves].sort(), s: [...shallowIn].sort(), d: depth ?? null });
    const cached = this.fetchCache.get(key);
    if (cached !== undefined) return cached;

    const shallowInSet = new Set(shallowIn);
    const haveClosure = this.reachableObjects(haves, shallowInSet);

    // Split the wants into tag objects and want-commits.
    const tagObjects: string[] = [];
    const wantCommits: string[] = [];
    for (const want of wants) {
      const object = this.store.getObject(want);
      if (object === undefined) throw new Error(`fetch wants unknown object ${want}`);
      if (object.type === 'tag') {
        tagObjects.push(want);
        const target = parseTag(object.data).object;
        const targetObject = this.store.getObject(target);
        if (targetObject !== undefined && targetObject.type === 'commit') wantCommits.push(target);
      } else if (object.type === 'commit') {
        wantCommits.push(want);
      }
    }

    // BFS over commits from the wants, tracking distance for the depth limit.
    const distance = new Map<string, number>();
    const bfsOrder: string[] = [];
    const queue: string[] = [];
    for (const commit of wantCommits) {
      if (!distance.has(commit)) {
        distance.set(commit, 0);
        queue.push(commit);
      }
    }
    let head = 0;
    while (head < queue.length) {
      const oid = queue[head++] as string;
      bfsOrder.push(oid);
      const d = distance.get(oid) as number;
      if (depth !== undefined && d + 1 >= depth) continue;
      const commit = this.store.parseCommitObject(oid);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (!distance.has(parent)) {
          distance.set(parent, d + 1);
          queue.push(parent);
        }
      }
    }

    const included = new Set<string>();
    for (const oid of bfsOrder) {
      const d = distance.get(oid) as number;
      if (depth !== undefined && d >= depth) continue;
      if (haveClosure.has(oid)) continue;
      included.add(oid);
    }

    // Shallow: an included commit whose parent is truly absent after this fetch
    // (not included and not already held). Unshallow: a shallow-in commit whose
    // parents are all included or already held.
    const shallow: string[] = [];
    for (const oid of bfsOrder) {
      if (!included.has(oid)) continue;
      const commit = this.store.parseCommitObject(oid);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (!included.has(parent) && !haveClosure.has(parent)) {
          shallow.push(oid);
          break;
        }
      }
    }
    const unshallow: string[] = [];
    for (const oid of shallowIn) {
      if (!shallowInSet.has(oid)) continue;
      const commit = this.store.parseCommitObject(oid);
      if (commit === null) continue;
      let complete = true;
      for (const parent of commit.parents) {
        if (!included.has(parent) && !haveClosure.has(parent)) {
          complete = false;
          break;
        }
      }
      if (complete) unshallow.push(oid);
    }

    const selected: Array<{ type: ObjectType; data: Buffer }> = [];
    const seenObjects = new Set<string>();
    const addObject = (oid: string): void => {
      if (seenObjects.has(oid) || haveClosure.has(oid)) return;
      const object = this.store.getObject(oid);
      if (object === undefined) return;
      seenObjects.add(oid);
      selected.push(object);
    };
    for (const tag of tagObjects) addObject(tag);
    for (const oid of bfsOrder) {
      if (!included.has(oid)) continue;
      for (const objectOid of this.store.flattenCommit(oid).objects) addObject(objectOid);
    }
    const pack = writePack(selected, this.store);
    const result: FetchSelection = { pack, shallow, unshallow };
    if (this.fetchCache.size < 256) this.fetchCache.set(key, result);
    return result;
  }

  /**
   * The ONE framing helper for a v2 fetch response, used by both the live path and
   * the V5 precompute path so the bytes can never drift. For the canonical shape
   * (haves empty) there is no acknowledgments section; the shallow-info section is
   * present exactly when shallow or unshallow is non-empty.
   */
  private buildFetchResponse(selection: FetchSelection, haves: readonly string[]): Buffer {
    const parts: Buffer[] = [];
    if (haves.length > 0) parts.push(pktLines(['acknowledgments\n', 'NAK\n', 'flush']));
    if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
      const section: Array<string | 'flush'> = ['shallow-info\n'];
      for (const oid of selection.shallow) section.push(`shallow ${oid}\n`);
      for (const oid of selection.unshallow) section.push(`unshallow ${oid}\n`);
      section.push('flush');
      parts.push(pktLines(section));
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPackets(selection.pack));
    // The packfile section ends with a flush: without it the client reads past
    // the end of the body and reports the remote hung up.
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }

  // ------------------------------------------------------------ advertisements

  private v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack'): string {
    if (service === 'git-upload-pack') {
      return `side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT} symref=HEAD:refs/heads/main`;
    }
    return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:refs/heads/main`;
  }

  /** A v0 ref advertisement, cached by refVersion so a push's cost is one lookup. */
  private v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
    const key = `${repo.owner}/${repo.name}:v${repo.refVersion}:${service}:v0`;
    const cached = this.adCache.get(key);
    if (cached !== undefined) return cached;
    const caps = this.v0Capabilities(service);
    const lines: string[] = [];
    const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (refs.length === 0) {
      lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    } else {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0]?.[1] ?? ZERO_OID;
      lines.push(`${tip} HEAD\0${caps}\n`);
      for (const [name, oid] of refs) {
        lines.push(`${oid} ${name}\n`);
        const object = this.store.getObject(oid);
        if (object !== undefined && object.type === 'tag') {
          const target = parseTag(object.data).object;
          lines.push(`${target} ${name}^{}\n`);
        }
      }
    }
    const body = Buffer.concat([pktLine(`# service=${service}\n`), PKT_FLUSH, pktLines([...lines, 'flush'])]);
    if (this.adCache.size < 1024) this.adCache.set(key, body);
    return body;
  }

  /** A v2 ls-refs answer, cached by refVersion and the request's arguments. */
  private lsRefsBody(repo: Repo, peel: boolean, symrefs: boolean, unborn: boolean, prefixes: readonly string[]): Buffer {
    const key = `${repo.owner}/${repo.name}:v${repo.refVersion}:ls:${peel}:${symrefs}:${unborn}:${prefixes.join(',')}`;
    const cached = this.adCache.get(key);
    if (cached !== undefined) return cached;
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const lines: string[] = [];
    const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (refs.length === 0) {
      if (unborn && (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix)))) {
        lines.push('unborn HEAD symref-target:refs/heads/main\n');
      }
    } else {
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (symrefs && tip !== undefined && (prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix)))) {
        lines.push(`${tip} HEAD symref-target:refs/heads/main\n`);
      }
      for (const [name, oid] of refs) {
        if (!keep(name)) continue;
        let line = `${oid} ${name}`;
        if (peel) {
          const object = this.store.getObject(oid);
          if (object !== undefined && object.type === 'tag') {
            line += ` peeled:${parseTag(object.data).object}`;
          }
        }
        lines.push(`${line}\n`);
      }
    }
    const body = Buffer.concat([pktLines(lines), PKT_FLUSH]);
    if (this.adCache.size < 1024) this.adCache.set(key, body);
    return body;
  }

  // ------------------------------------------------------------ routing

  private repoOf(owner: string, repoName: string): Repo | null {
    if (owner !== this.store.viewerLogin) return null;
    return this.store.getRepo(owner, repoName) ?? null;
  }

  /** The git dispatcher: info/refs, upload-pack, receive-pack under /{owner}/{repo}.git/. */
  handleGit(req: IncomingMessage, res: ServerResponse, body: Buffer, pathname: string, segments: readonly string[]): boolean {
    // /{owner}/{repo}.git/... — match on the .git/ segment, never on a trailing .git.
    // V6: pathname + segments arrive pre-parsed from app.ts (no URL re-parse here).
    if (segments.length < 2 || !segments[1]?.endsWith('.git')) return false;
    const owner = segments[0] as string;
    const repoName = (segments[1] as string).slice(0, -'.git'.length);
    const tail = segments.slice(2);
    const method = req.method ?? 'GET';
    try {
      if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
        const queryPart = req.url === undefined ? '' : (req.url.split('?', 2)[1] ?? '');
        const service = new URLSearchParams(queryPart).get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendError(res, 400, 'unknown service');
          return true;
        }
        const repo = this.repoOf(owner, repoName);
        if (repo === null) {
          sendNotFound(res, 'Not Found');
          return true;
        }
        const wantsV2 = service === 'git-upload-pack' && req.headers['git-protocol'] === 'version=2';
        if (wantsV2) {
          sendBytes(res, 200, this.v2Advertisement, 'application/x-git-upload-pack-advertisement');
        } else {
          sendBytes(res, 200, this.v0Advertisement(repo, service), `application/x-${service}-advertisement`);
        }
        return true;
      }
      if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
        const repo = this.repoOf(owner, repoName);
        if (repo === null) {
          sendNotFound(res, 'Not Found');
          return true;
        }
        const isV2 = req.headers['git-protocol'] === 'version=2';
        const out = isV2 ? this.handleUploadPackV2(repo, body) : this.handleUploadPackV0(repo, body);
        sendBytes(res, 200, out, 'application/x-git-upload-pack-result');
        return true;
      }
      if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
        const repo = this.repoOf(owner, repoName);
        if (repo === null) {
          sendNotFound(res, 'Not Found');
          return true;
        }
        const out = this.handleReceivePack(repo, body);
        sendBytes(res, 200, out, 'application/x-git-receive-pack-result');
        return true;
      }
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'bad request');
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ upload-pack v2

  private parseV2Command(body: Buffer): { command: string; args: string[] } {
    const { packets } = decodePktLines(body);
    const lines: string[] = [];
    let command = '';
    let pastDelim = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        pastDelim = true;
        continue;
      }
      if (packet.kind === 'flush') break;
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8');
      if (!pastDelim) {
        if (text.startsWith('command=')) command = text.slice('command='.length).replace(/\n$/, '');
      } else {
        lines.push(text.replace(/\n$/, ''));
      }
    }
    if (command === '') throw new Error('upload-pack request has no command');
    return { command, args: lines };
  }

  private handleLsRefs(repo: Repo, args: readonly string[]): Buffer {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const arg of args) {
      if (arg === 'peel') peel = true;
      else if (arg === 'symrefs') symrefs = true;
      else if (arg === 'unborn') unborn = true;
      else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    }
    return this.lsRefsBody(repo, peel, symrefs, unborn, prefixes);
  }

  private handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
    const { command, args } = this.parseV2Command(body);
    if (command === 'ls-refs') return this.handleLsRefs(repo, args);
    if (command !== 'fetch') throw new Error(`unknown upload-pack command ${JSON.stringify(command)}`);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowIn: string[] = [];
    let depth: number | undefined;
    for (const arg of args) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) shallowIn.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) {
        const n = Number(arg.slice(7).trim());
        if (Number.isFinite(n)) depth = n;
      }
    }
    if (wants.length === 0) return this.buildFetchResponse({ pack: writePack([], this.store), shallow: [], unshallow: [] }, haves);

    // V5: the canonical shallow clone (wants=[default-branch tip], haves=[],
    // shallowIn=[], depth=1) serves a precomputed response Buffer.
    const canonical =
      wants.length === 1 &&
      haves.length === 0 &&
      shallowIn.length === 0 &&
      depth === 1 &&
      wants[0] === repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (canonical) {
      const key = `${repo.owner}/${repo.name}`;
      const entry = this.cloneResponseCache.get(key);
      if (entry !== undefined && entry.tip === (wants[0] as string) && entry.refVersion === repo.refVersion) {
        return entry.body;
      }
      const selection = this.fetchSelection(wants, haves, shallowIn, depth);
      const response = this.buildFetchResponse(selection, haves);
      this.cloneResponseCache.set(key, { tip: wants[0] as string, refVersion: repo.refVersion, body: response });
      return response;
    }
    const selection = this.fetchSelection(wants, haves, shallowIn, depth);
    return this.buildFetchResponse(selection, haves);
  }

  // ------------------------------------------------------------ upload-pack v0

  private handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
    const { packets } = decodePktLines(body);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowIn: string[] = [];
    let depth: number | undefined;
    let inSecondSection = false;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        inSecondSection = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (!inSecondSection) {
        if (text.startsWith('want ')) wants.push(text.slice(5).split(' ')[0] as string);
        else if (text.startsWith('shallow ')) shallowIn.push(text.slice(8).trim());
        else if (text.startsWith('deepen ')) {
          const n = Number(text.slice(7).trim());
          if (Number.isFinite(n)) depth = n;
        }
      } else {
        if (text.startsWith('have ')) haves.push(text.slice(5).trim());
      }
    }
    if (wants.length === 0) return Buffer.concat([pktLine('NAK\n'), sidebandPackets(writePack([], this.store)), PKT_FLUSH]);
    const selection = this.fetchSelection(wants, haves, shallowIn, depth);
    const parts: Buffer[] = [pktLine('NAK\n')];
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(sidebandPackets(selection.pack));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }

  // ------------------------------------------------------------ receive-pack v0

  /**
   * The push report, as real git writes it: one band-1 packet carrying the
   * pkt-lined report lines followed by a flush INSIDE band 1 (the reader reads
   * report lines until that flush — without it, it reads a third line, hits
   * EOF and reports the remote hung up), then a flush on the wire.
   */
  private sidebandReport(lines: readonly string[]): Buffer {
    const report = Buffer.concat([pktLines(lines), PKT_FLUSH]);
    const parts: Buffer[] = [];
    const CHUNK = 65515;
    for (let offset = 0; offset < report.length; offset += CHUNK) {
      const slice = report.subarray(offset, Math.min(report.length, offset + CHUNK));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }

  private handleReceivePack(repo: Repo, body: Buffer): Buffer {
    let commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    let pack: Buffer = Buffer.alloc(0);
    try {
      const { packets, trailing } = decodePktLines(body, { allowTrailing: true });
      pack = trailing;
      for (const packet of packets) {
        if (packet.kind === 'flush') break;
        if (packet.kind !== 'data') continue;
        let text = packet.payload.toString('utf8');
        const nul = text.indexOf('\0');
        if (nul >= 0) text = text.slice(0, nul);
        text = text.replace(/\n$/, '');
        if (text === '') continue;
        const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(text);
        if (match === null) throw new Error(`malformed receive-pack command ${JSON.stringify(text.slice(0, 60))}`);
        commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
      }
    } catch (err) {
      return this.sidebandReport([`unpack ${err instanceof Error ? err.message : 'error'}\n`]);
    }
    if (commands.length === 0) return this.sidebandReport(['unpack error\n']);

    // Parse the pack once when any command carries objects; a failure unpacks nothing.
    const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
    if (needsPack) {
      try {
        const parsed = readPack(pack, this.store);
        for (const [oid, object] of parsed.objects) {
          if (!this.store.hasObject(oid)) this.store.putObjectKnown(oid, object.type, object.data);
        }
      } catch (err) {
        return this.sidebandReport([`unpack ${err instanceof Error ? err.message : 'error'}\n`]);
      }
    }

    const lines: string[] = ['unpack ok\n'];
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) lines.push(`ng ${command.ref} no such ref\n`);
        else if (command.oldOid !== current) lines.push(`ng ${command.ref} non-fast-forward\n`);
        else {
          repo.deleteRef(command.ref);
          lines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (current === undefined) {
        // Create.
        if (command.oldOid !== ZERO_OID) lines.push(`ng ${command.ref} non-fast-forward\n`);
        else {
          repo.setRef(command.ref, command.newOid);
          lines.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      // Update.
      if (command.oldOid !== current) {
        lines.push(`ng ${command.ref} non-fast-forward\n`);
      } else if (command.newOid === current) {
        lines.push(`ok ${command.ref}\n`);
      } else if (command.ref.startsWith('refs/tags/')) {
        lines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        // O(1) common case first: the new commit's parents include the current tip.
        let fastForward = false;
        const newCommit = this.store.parseCommitObject(command.newOid);
        if (newCommit !== null) {
          fastForward = newCommit.parents.includes(current);
          if (!fastForward) fastForward = this.store.isAncestor(current, command.newOid);
        } else {
          fastForward = this.store.isAncestor(current, command.newOid);
        }
        if (fastForward) {
          repo.setRef(command.ref, command.newOid);
          lines.push(`ok ${command.ref}\n`);
        } else {
          lines.push(`ng ${command.ref} non-fast-forward\n`);
        }
      }
    }
    return this.sidebandReport(lines);
  }
}
