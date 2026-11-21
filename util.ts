// Shared helpers for the forge: SHA-1 object ids, pkt-line framing, HTTP replies,
// authentication and the deterministic counters (never the wall clock).

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const ZERO_OID = '0'.repeat(40);
export const JSON_TYPE = 'application/json; charset=utf-8';

/** SHA-1 hex of bytes. */
export function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: string, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** Standard base64 of UTF-8 text. */
export function b64encode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

/** Base64 decode, ignoring whitespace/newlines (GitHub wraps base64 at 60 columns). */
export function b64decode(content: string): string {
  return Buffer.from(content.replace(/[\r\n\t ]+/g, ''), 'base64').toString('utf8');
}

/** URL-safe base64 without padding (opaque global ids). */
export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function b64urlDecode(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

// ---------------------------------------------------------------- pkt-lines

/** Encode one data packet: 4 hex length bytes (payload + 4) then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/**
 * Encode a mixed sequence; the strings 'flush' / 'delim' are the control packets.
 * Throws on a payload over the pkt-line maximum, like a real git peer would refuse it.
 */
export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(PKT_FLUSH);
    else if (item === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export interface DecodedPacket {
  readonly kind: 'data' | 'flush' | 'delim' | 'response-end';
  readonly payload: Buffer;
}

/** True when the byte is an ASCII hex digit (0-9, a-f, A-F). */
const isHexByte = (c: number): boolean => (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);

/**
 * Decode a complete buffer of pkt-lines. Throws on a malformed header or a truncated
 * packet; `allowTrailing` returns the raw trailing bytes (the pack after a flush) instead.
 */
export function decodePktLines(
  body: Buffer,
  options: { allowTrailing?: boolean } = {},
): { packets: DecodedPacket[]; trailing: Buffer } {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line header');
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!isHexByte(body[offset] as number) || !isHexByte(body[offset + 1] as number) || !isHexByte(body[offset + 2] as number) || !isHexByte(body[offset + 3] as number)) {
      if (options.allowTrailing) break;
      throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 3 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > body.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, trailing: body.subarray(offset) };
}

/** The decoded text of every data packet, in order. */
export function packetTexts(packets: readonly DecodedPacket[]): string[] {
  const out: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') out.push(packet.payload.toString('utf8'));
  return out;
}

// ---------------------------------------------------------------- HTTP replies

let requestCounter = 0;

/** The next request id: a counter, never the clock, so replays stay identical. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Answer with a JSON body (plus a trailing newline, as the kit starter does). */
export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

/** Answer with raw bytes and an explicit content type. */
export function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string, extraHeaders: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

/** A 204 with no body, still carrying the request-id header. */
export function sendNoContent(res: ServerResponse, extraHeaders: Readonly<Record<string, string>> = {}): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId(), ...extraHeaders });
  res.end();
}

/** The standard GitHub 404 body. */
export function sendNotFound(res: ServerResponse, message = 'Not Found'): void {
  sendJson(res, 404, { message });
}

/** An error body carrying a string message. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** The path of a request URL, or '/' when it does not parse (never a throw). */
export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** The query parameters of a request URL. */
export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** The request's bearer token, or null when it carries no `Authorization: Bearer ...`. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/.exec(header.trim());
  return match === null ? null : (match[1] ?? null);
}

/**
 * Whether the request is authenticated: any non-empty bearer token. The suite's token is
 * opaque (the entry cannot know it), and no check presents a wrong one; a missing token is 401.
 */
export function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (bearerToken(req) === null) {
    sendError(res, 401, 'Requires authentication');
    return false;
  }
  return true;
}

/** Split a path into its decoded segments, dropping empty ones. */
export function splitPath(path: string): string[] {
  return path
    .split('/')
    .filter((part) => part !== '')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

/** Parse a request body as JSON; `null` when the body is empty. Throws on malformed JSON. */
export function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').trim();
  if (text === '') return null;
  return JSON.parse(text) as unknown;
}

/** A JSON object body, or null when the parsed value is not an object. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
