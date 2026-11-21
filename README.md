# github-core-clone-01 — Forge (V6)

A minimal GitHub-compatible forge in one Node 22 process, stdlib only: no git
binary, no install step. It speaks smart-HTTP git (protocol v0 and v2, fetch and
receive-pack), the REST API v3 surface the suite exercises (repos, refs, branches,
commits, contents, labels, issues and comments, pull requests with files and
squash merge), a hand-rolled GraphQL endpoint, and MCP over JSON-RPC 2.0.

Run it with `node --experimental-strip-types main.ts`. The lifecycle in `main.ts`
registers the listening port with the environment URL and exits when the
environment reports done.

## Layout

- `app.ts` — the dispatcher: healthz, git, the single-issue fast path, REST, GraphQL, MCP.
- `git.ts` — pkt-line codec, packfile read/write, v0/v2 upload-pack, receive-pack.
- `store.ts` — the in-memory object store, refs, issues, pulls, and serializers.
- `rest.ts` — REST API v3 routes.
- `graphql.ts` — a hand-rolled GraphQL parser and executor.
- `mcp.ts` — MCP JSON-RPC 2.0 and the six tools.
- `util.ts` — hashing, pkt-lines, HTTP senders, auth.
- `wire.ts` — the frozen deterministic scenario (kit copy).

Determinism: commit timestamps come from a counter over a fixed epoch, never the
wall clock, and request ids come from a counter, so a replay produces
byte-identical state.

## Optimizations

**V1 — read path.** Each repo keeps an `issueMap` (number → issue) and the store
keeps a cache of serialized single-issue GET bodies. `app.ts` answers a GET for
one issue from that cache before the generic REST router; any mutation of the
issue (patch, label add/remove, comment add/delete, delete) invalidates its
entry, and label creation or repo deletion invalidates the whole repo's entries.

**V2 — clone path.** Three caches, all keyed by everything that determines the
bytes: `commitCache` flattens a commit once (tree walk in DFS pre-order, objects
immutable, so it is never invalidated); `fetchCache` stores a whole fetch
selection (pack plus shallow/unshallow lines) by wants/haves/shallow/depth; and
`adCache` stores v0 ref advertisements and v2 ls-refs answers by `refVersion`,
which is bumped on every ref mutation. The v2 capability advertisement is
identical for every repo and is built once in the constructor.

**V3 — write path.** `readPack` parses a received pack in a single pass —
header and trailer verified, one zlib stream inflated per entry, deltas resolved
recursively with memoization, each object hashed exactly once — and
receive-pack stores each object with one `Map.set`. The fast-forward check tries
the O(1) common case first (the new commit's parents include the current tip)
and only then walks ancestry. Issue creation parses the body once and serializes
the returned object directly.

**V4 — the three stacked optimizations together.** V1 + V2 + V3 in one tree,
kept independent: no shared mutable state between them except the caches named
above, and invalidation covering every mutation path (including the write-path
ones).

**V5 — clone precomputation (the one change over V4).** The clone workload's
fetch has exactly one shape: wants = the default branch's tip, no haves, no
shallow-in, depth 1. `GitService` keeps a dedicated `cloneResponseCache`
(`owner/repo` → `{tip, refVersion, body}`), separate from the fetch cache and
not subject to its cap. On the first matching fetch after a tip change the full
v2 fetch response — acknowledgments (none), shallow-info, packfile, sideband
pack — is built once through the same `buildFetchResponse` helper the live path
uses, so the bytes cannot drift, and stored. Later matching fetches return that
Buffer directly: no selection, no framing, no allocation. Invalidation is by
construction: `refVersion` is bumped on every ref mutation and the tip is
checked as a second guard. Nothing on the push path touches this cache, and the
response is never built on the push path — it is built lazily, on the first
matching fetch, which pays the cost once.

**V6 — lean dispatch (the changes over V5).** Five small, zero-behaviour-change
cuts, all on hot paths:

- **A. REST dispatch fast path (write workload).** The write workload is 200
  sequential `POST /api/v3/repos/:owner/:repo/issues`. The dispatcher now
  matches that one hot route before the linear 32-route scan and hands the
  handler the already-exec'd regex match, so the handler never re-parses the
  URL or re-execs the regex. Auth still runs first, exactly as before, and a
  non-matching pathname falls through to the loop unchanged.
- **B. Read-cache bug fix (read workload) — a real bug.** The V1 single-issue
  cache never hit: `app.ts` looked the cache up with
  `cacheKey(owner, repoName, number)` while the method's signature is
  `cacheKey(repo, number)`, so the lookup key was `undefined/undefined#N`
  while the stored key was `owner/repo#N`. Worse, the stored value was the
  issueJson record object, so a fixed key alone would have made the hit path
  throw. V6 fixes both halves: the lookup passes the repo object, and
  `cacheIssue` stores the exact response bytes (`JSON.stringify(body)` +
  `"\n"`) as a `Buffer`. A cache hit now sends those bytes verbatim with a
  fresh `X-GitHub-Request-Id` per request. Invalidation is unchanged.
- **C. Push: skip the double SHA-1 (push workload).** `readPack` already hashes
  every object once; receive-pack then hashed each one again via
  `putObject`. The new `putObjectKnown(oid, type, data)` stores under the
  oid `readPack` computed, without re-hashing. Stored bytes and ids are
  identical.
- **D. Git routing: stop re-parsing the URL (clone workload).** `app.ts`
  already parses the URL and splits the path; `handleGit` parsed it again
  and `queryOf` parsed it a third time for info/refs. The pathname and the
  already-split segments are now passed in, and the `service=` query is read
  by splitting `req.url` on `?` once and feeding the query part to
  `URLSearchParams` — no URL object. Behaviour for a missing/unknown service
  (400) and a missing URL (400) is identical.
- **E. pkt-line header check without a regex (all git requests).**
  `decodePktLines` validated every 4-byte packet header with a regex; it now
  uses a 4-byte hex-digit char-code check with exactly the same accept set
  (`[0-9a-fA-F]{4}`).
