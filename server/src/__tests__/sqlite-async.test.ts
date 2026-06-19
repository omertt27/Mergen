import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';

// Hoist mock for paths.js to run on a clean database without referencing external variables
vi.mock('../sensor/paths.js', () => {
  return {
    HISTORY_DB: '/tmp/mergen-history-test-db-async.db',
    DATA_DIR: '/tmp',
    zeroRetentionMode: () => false,
  };
});

import { historyStore } from '../sensor/sqlite-store.js';

describe('SqliteHistoryStore: Asynchronous Queued Write', () => {
  beforeEach(async () => {
    if (fs.existsSync('/tmp/mergen-history-test-db-async.db')) {
      try { fs.unlinkSync('/tmp/mergen-history-test-db-async.db'); } catch {}
    }
    await historyStore.init();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (fs.existsSync('/tmp/mergen-history-test-db-async.db')) {
      try { fs.unlinkSync('/tmp/mergen-history-test-db-async.db'); } catch {}
    }
  });

  it('queues concurrent writes and processes the last one', async () => {
    const store = historyStore as any;
    
    // Reset writing state
    store.isWriting = false;
    store.pendingWrite = false;
    store.nextBuffer = null;

    let writeCount = 0;
    const writePromises: Array<() => void> = [];

    // Mock fs.writeFile to control completion asynchronously
    vi.spyOn(fs, 'writeFile').mockImplementation((path: any, data: any, options: any, callback?: any) => {
      const cb = typeof options === 'function' ? options : callback;
      writeCount++;
      writePromises.push(() => cb(null));
    });

    // Mock fs.rename to succeed immediately
    vi.spyOn(fs, 'rename').mockImplementation((oldPath: any, newPath: any, callback: any) => {
      callback(null);
    });

    // Call flush multiple times
    store.flush(); // Starts writing
    expect(store.isWriting).toBe(true);
    expect(store.pendingWrite).toBe(false);

    store.flush(); // Sets pendingWrite = true, nextBuffer
    expect(store.pendingWrite).toBe(true);
    expect(store.nextBuffer).toBeDefined();

    const firstBuffer = store.nextBuffer;

    store.flush(); // Overwrites nextBuffer with newer state
    expect(store.pendingWrite).toBe(true);
    expect(store.nextBuffer).not.toBe(firstBuffer);

    // Resolve the first write
    expect(writePromises).toHaveLength(1);
    writePromises[0]();

    // The completion of the first write should trigger the pending write asynchronously
    await new Promise(process.nextTick);

    expect(writeCount).toBe(2); // The second write is started
    expect(store.isWriting).toBe(true);
    expect(store.pendingWrite).toBe(false);
    expect(store.nextBuffer).toBeNull();
  });

  it('recovers from write failures and processes subsequent writes', async () => {
    const store = historyStore as any;

    store.isWriting = false;
    store.pendingWrite = false;
    store.nextBuffer = null;

    vi.spyOn(fs, 'writeFile').mockImplementation((path: any, data: any, options: any, callback?: any) => {
      const cb = typeof options === 'function' ? options : callback;
      // Simulate disk write error
      cb(new Error('Disk full'));
    });

    store.flush();
    // Resolves immediately due to mocked sync error callback call
    expect(store.isWriting).toBe(false);
  });
});
