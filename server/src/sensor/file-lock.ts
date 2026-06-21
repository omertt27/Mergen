import fs from 'fs';
import logger from './logger.js';

/**
 * Acquires a filesystem-based lock, runs the provided callback, and releases the lock.
 * Employs a retry loop to wait if the lock is held. Fails open (after a timeout) to prevent blocking.
 */
export function lockAndExecute<T>(lockFilePath: string, fn: () => T): T {
  const maxRetries = 100;
  const retryDelayMs = 10;
  let acquired = false;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const fd = fs.openSync(lockFilePath, 'wx');
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (err) {
      // Synchronous sleep delay
      const start = Date.now();
      while (Date.now() - start < retryDelayMs) {}
    }
  }

  if (!acquired) {
    logger.warn({ lockFilePath }, 'file-lock: failed to acquire lock within timeout — executing anyway to prevent deadlock');
  }

  try {
    return fn();
  } finally {
    if (acquired) {
      try {
        fs.unlinkSync(lockFilePath);
      } catch (err) {}
    }
  }
}
