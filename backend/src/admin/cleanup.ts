const cleanupIntervalMs = 60 * 60 * 1000;
const securityCleanupIntervalMs = 60 * 60 * 1000;

export function startRejectedPostCleanup(
  purge: () => Promise<number>,
  intervalMs = cleanupIntervalMs,
): () => void {
  let running = false;
  let stopped = false;

  const run = async (): Promise<void> => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      const deleted = await purge();
      if (deleted > 0) {
        console.log(`Permanently deleted ${deleted} rejected posts`);
      }
    } catch {
      console.error("Rejected post cleanup failed");
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function startSecurityDataCleanup(
  purge: () => Promise<number>,
  intervalMs = securityCleanupIntervalMs,
): () => void {
  let running = false;
  let stopped = false;

  const run = async (): Promise<void> => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      await purge();
    } catch {
      console.error("Security data cleanup failed");
    } finally {
      running = false;
    }
  };

  void run();
  const timer = setInterval(() => void run(), intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
