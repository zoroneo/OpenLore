/**
 * Dependency-light stdin reader for hook consumers.
 *
 * Lives in utils (no analyzer/LLM imports) so latency-sensitive hooks — `orient` and the
 * `panic-check` PreToolUse guard — can read the hook payload without pulling a heavy import graph
 * into process startup.
 */

/**
 * Read all of stdin (the hook payload). Resolves '' when stdin is a TTY (nothing piped).
 * Exported for testing; defaults to `process.stdin`.
 *
 * Load-bearing for the "a hook must never hang the user's turn" contract: when the fallback timer
 * fires (a writer that opened the pipe but never wrote/closed it), `done()` not only resolves but
 * TEARS DOWN the stream — pausing it, detaching listeners, and unref-ing the underlying handle — so
 * the process can exit immediately instead of waiting for an EOF that may never come. Resolving the
 * promise alone is not enough: a still-referenced, flowing stdin keeps the event loop alive until
 * the writer closes the pipe.
 */
export function readStdin(
  stream: NodeJS.ReadStream = process.stdin,
  timeoutMs = 1500,
): Promise<string> {
  return new Promise(resolve => {
    if (stream.isTTY) return resolve('');
    let data = '';
    let settled = false;
    const onData = (chunk: string): void => {
      data += chunk;
    };
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', done);
      stream.removeListener('error', done);
      stream.pause();
      stream.unref?.();
      resolve(data);
    };
    stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.on('end', done);
    stream.on('error', done);
    // A hook must never hang the user's turn: if stdin neither closes nor errors,
    // proceed with whatever arrived (typically '') and detach.
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
  });
}
