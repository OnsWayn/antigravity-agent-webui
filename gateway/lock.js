function createSessionLockManager({
  // Queue wait limit for waiters. The holder is never timed out.
  defaultTimeoutMs = 120000,
  defaultQueueLimit = 3,
  onLockEvent = () => {}
} = {}) {
  const locks = new Map();

  function busyError(message) {
    const error = new Error(message);
    error.status = 429;
    error.code = 'session_busy';
    return error;
  }

  function getOrCreate(sessionKey) {
    let lockEntry = locks.get(sessionKey);
    if (!lockEntry) {
      lockEntry = {
        running: false,
        currentRequestId: null,
        queue: []
      };
      locks.set(sessionKey, lockEntry);
    }
    return lockEntry;
  }

  function clearWaiterTimer(item) {
    if (item?.timer) {
      clearTimeout(item.timer);
      item.timer = null;
    }
  }

  function grantTo(lockEntry, sessionKey, requestId, resolve) {
    lockEntry.running = true;
    lockEntry.currentRequestId = requestId;
    resolve(() => releaseLock(sessionKey, requestId));
  }

  async function acquireLock(sessionKey, {
    requestId = 'unknown',
    timeoutMs = defaultTimeoutMs,
    queueLimit = defaultQueueLimit
  } = {}) {
    if (!sessionKey) {
      return () => {};
    }

    const lockEntry = getOrCreate(sessionKey);

    if (!lockEntry.running) {
      lockEntry.running = true;
      lockEntry.currentRequestId = requestId;
      onLockEvent('debug', 'session_lock_acquired', { sessionKey, requestId });
      return () => releaseLock(sessionKey, requestId);
    }

    if (lockEntry.queue.length >= queueLimit) {
      onLockEvent('warn', 'session_lock_rejected_busy', {
        sessionKey,
        requestId,
        currentRequestId: lockEntry.currentRequestId,
        queueLength: lockEntry.queue.length
      });
      throw busyError(`Session is busy processing another request (${lockEntry.queue.length} in queue)`);
    }

    onLockEvent('debug', 'session_lock_queued', {
      sessionKey,
      requestId,
      queuePosition: lockEntry.queue.length + 1,
      currentRequestId: lockEntry.currentRequestId
    });

    return new Promise((resolve, reject) => {
      const item = {
        requestId,
        timer: null,
        resolve: () => {
          clearWaiterTimer(item);
          onLockEvent('debug', 'session_lock_acquired_from_queue', { sessionKey, requestId });
          grantTo(lockEntry, sessionKey, requestId, resolve);
        },
        reject: (error) => {
          clearWaiterTimer(item);
          reject(error);
        }
      };

      if (timeoutMs > 0) {
        item.timer = setTimeout(() => {
          const idx = lockEntry.queue.indexOf(item);
          if (idx >= 0) lockEntry.queue.splice(idx, 1);
          onLockEvent('warn', 'session_lock_wait_timeout', {
            sessionKey,
            requestId,
            currentRequestId: lockEntry.currentRequestId,
            timeoutMs
          });
          item.reject(busyError(`Session is busy; waited ${timeoutMs}ms for lock`));
        }, timeoutMs);
        if (typeof item.timer.unref === 'function') item.timer.unref();
      }

      lockEntry.queue.push(item);
    });
  }

  function releaseLock(sessionKey, requestId) {
    if (!sessionKey) return;
    const lockEntry = locks.get(sessionKey);
    if (!lockEntry) return;

    if (lockEntry.running && lockEntry.currentRequestId !== requestId) {
      onLockEvent('debug', 'session_lock_release_ignored', {
        sessionKey,
        requestId,
        currentRequestId: lockEntry.currentRequestId
      });
      return;
    }

    if (lockEntry.queue.length > 0) {
      const next = lockEntry.queue.shift();
      next.resolve();
      return;
    }

    lockEntry.running = false;
    lockEntry.currentRequestId = null;
    locks.delete(sessionKey);
    onLockEvent('debug', 'session_lock_released', { sessionKey, requestId });
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
