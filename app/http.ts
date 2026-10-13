import type { IncomingMessage, ServerResponse } from 'node:http';

export async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Returns {} for an empty body and undefined for invalid JSON. */
export function parseJson(raw: string): any {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
