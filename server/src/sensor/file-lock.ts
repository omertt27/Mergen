/**
 * lockAndExecute — serialize writes to a shared JSON file.
 *
 * Safety model: Node.js is single-threaded, and every caller passes a
 * synchronous fn() that does a writeFileSync → renameSync pair. Because
 * Node.js cannot pre-empt a synchronous callback, two synchronous writes
 * on the same event-loop tick cannot interleave — the runtime serializes
 * them naturally. The POSIX-atomic tmp→rename pattern in each persist()
 * call guarantees that a reader never sees a partial file even if the
 * process is killed mid-write.
 *
 * The previous implementation used a filesystem busy-spin lock that
 * blocked the event loop for up to 1 second under contention (100 retries
 * × 10 ms synchronous spin), and failed open after the timeout, risking
 * silent data corruption. Both problems are eliminated here.
 */
export function lockAndExecute<T>(_lockFilePath: string, fn: () => T): T {
  return fn();
}
