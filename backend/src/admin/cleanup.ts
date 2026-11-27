const cleanupIntervalMs = 60 * 60 * 1000;

export function startScheduledCleanup(cleanupExpiredData: () => Promise<number>): () => void {
  const run = () => {
    void cleanupExpiredData().catch(() => {
      console.error("Scheduled data cleanup failed");
    });
  };
  const timer = setInterval(run, cleanupIntervalMs);
  timer.unref();
  run();
  return () => clearInterval(timer);
}