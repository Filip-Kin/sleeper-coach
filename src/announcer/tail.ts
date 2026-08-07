import { statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import type { ActivityEvent } from "../log.ts";

// Tails the append-only activity JSONL written by the coach in another process.
// We NEVER hold the file open exclusively: each poll opens it, reads only the
// bytes appended since our last offset, then closes it. A partial trailing line
// (no newline yet) is carried to the next poll. If the file shrinks (truncated
// or rotated), we reset to the start.
//
// By default we seed the offset at the current end of file so a restart does not
// replay the whole draft; pass fromStart to read history too.

// #region types
export interface TailOptions {
  path: string;
  onEvent: (ev: ActivityEvent) => void;
  onError?: (err: Error) => void;
  fromStart?: boolean;
  intervalMs?: number;
}
// #endregion

export function startTail(opts: TailOptions): () => void {
  const intervalMs = opts.intervalMs ?? 500;
  const decoder = new TextDecoder();
  let offset = 0;
  let carry = "";
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (!opts.fromStart && existsSync(opts.path)) {
    try {
      offset = statSync(opts.path).size;
    } catch {
      offset = 0;
    }
  }

  function readDelta(): void {
    if (!existsSync(opts.path)) return;
    const size = statSync(opts.path).size;
    if (size < offset) {
      // Truncated or rotated: start over from the top.
      offset = 0;
      carry = "";
    }
    if (size <= offset) return;

    const len = size - offset;
    const buf = Buffer.allocUnsafe(len);
    const fd = openSync(opts.path, "r");
    let read: number;
    try {
      read = readSync(fd, buf, 0, len, offset);
    } finally {
      closeSync(fd);
    }
    offset += read;
    carry += decoder.decode(buf.subarray(0, read));

    let nl: number;
    while ((nl = carry.indexOf("\n")) !== -1) {
      const line = carry.slice(0, nl).trim();
      carry = carry.slice(nl + 1);
      if (!line) continue;
      let ev: ActivityEvent;
      try {
        ev = JSON.parse(line) as ActivityEvent;
      } catch {
        // A malformed line should not kill the tailer; skip it.
        continue;
      }
      opts.onEvent(ev);
    }
  }

  function poll(): void {
    if (stopped) return;
    try {
      readDelta();
    } catch (err) {
      opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
    if (!stopped) timer = setTimeout(poll, intervalMs);
  }

  timer = setTimeout(poll, intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
