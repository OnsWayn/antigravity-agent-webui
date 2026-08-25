function createSessionLockManager({
  defaultTimeoutMs = 120000,
  defaultQueueLimit = 3,
  onLockEvent = () => {}
} = {}) {
  const locks = new Map();

  async function acquireLock(sessionKey, {
    requestId = 'unknown',
    timeoutMs = defaultTimeoutMs,
    queueLimit = defaultQueueLimit
  } = {}) {
    if (!sessionKey) {
      return () => {};
    }

    let lockEntry = locks.get(sessionKey);
    if (!lockEntry) {
      lockEntry = {
        running: false,
        currentRequestId: null,
        queue: [],
        timer: null
      };
      locks.set(sessionKey, lockEntry);
    }

    if (!lockEntry.running) {
      lockEntry.running = true;
      lockEntry.currentRequestId = requestId;

      if (timeoutMs > 0) {
        lockEntry.timer = setTimeout(() => {
          onLockEvent('warn', 'session_lock_timeout', {
            sessionKey,
            requestId,
            timeoutMs
          });
          releaseLock(sessionKey, requestId);
        }, timeoutMs);
        if (typeof lockEntry.timer.unref === 'function') {
          lockEntry.timer.unref();
        }
      }

      onLockEvent('debug', 'session_lock_acquired', { sessionKey, requestId });
      return () => releaseLock(sessionKey, requestId);
    }

    // Lock is currently held, check queue limit
    if (lockEntry.queue.length >= queueLimit) {
      onLockEvent('warn', 'session_lock_rejected_busy', {
        sessionKey,
        requestId,
        currentRequestId: lockEntry.currentRequestId,
        queueLength: lockEntry.queue.length
      });
      const error = new Error(`Session is busy processing another request (${lockEntry.queue.length} in queue)`);
      error.status = 429;
      error.code = 'session_busy';
      throw error;
    }

    onLockEvent('debug', 'session_lock_queued', {
      sessionKey,
      requestId,
      queuePosition: lockEntry.queue.length + 1
    });

    return new Promise((resolve, reject) => {
      lockEntry.queue.push({
        requestId,
        timeoutMs,
        resolve: () => {
          onLockEvent('debug', 'session_lock_acquired_from_queue', { sessionKey, requestId });
          resolve(() => releaseLock(sessionKey, requestId));
        },
        reject
      });
    });
  }

  function releaseLock(sessionKey, requestId) {
    if (!sessionKey) return;
    const lockEntry = locks.get(sessionKey);
    if (!lockEntry) return;

    if (lockEntry.timer) {
      clearTimeout(lockEntry.timer);
      lockEntry.timer = null;
    }

    if (lockEntry.queue.length > 0) {
      const next = lockEntry.queue.shift();
      lockEntry.running = true;
      lockEntry.currentRequestId = next.requestId;

      if (next.timeoutMs > 0) {
        lockEntry.timer = setTimeout(() => {
          onLockEvent('warn', 'session_lock_timeout', {
            sessionKey,
            requestId: next.requestId,
            timeoutMs: next.timeoutMs
          });
          releaseLock(sessionKey, next.requestId);
        }, next.timeoutMs);
        if (typeof lockEntry.timer.unref === 'function') {
          lockEntry.timer.unref();
        }
      }

      next.resolve();
    } else {
      lockEntry.running = false;
      lockEntry.currentRequestId = null;
      locks.delete(sessionKey);
      onLockEvent('debug', 'session_lock_released', { sessionKey, requestId });
    }
  }

  return {
    acquireLock,
    releaseLock,
    getActiveLocks: () => locks.size
  };
}

module.exports = {
  createSessionLockManager
};
