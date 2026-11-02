/** Tracks accepted work so shutdown can drain it before disconnecting the DB. */
export function createBackgroundTaskGroup(report: (error: unknown, name: string) => void) {
  const active = new Map<string, Set<Promise<void>>>();
  let stopped = false, draining: Promise<void> | undefined;
  return {
    run(name: string, operation: () => Promise<unknown>, concurrency = 1): boolean {
      let tasks = active.get(name);
      if (stopped || (tasks?.size || 0) >= concurrency) return false;
      if (!tasks) { tasks = new Set(); active.set(name, tasks); }
      const group = tasks;
      const task = Promise.resolve().then(operation)
        .then(() => undefined)
        .catch(error => report(error, name))
        .finally(() => { group.delete(task); if (!group.size) active.delete(name); });
      group.add(task);
      return true;
    },
    drain(): Promise<void> {
      stopped = true;
      return draining ||= Promise.allSettled([...active.values()].flatMap(tasks => [...tasks])).then(() => undefined);
    },
  };
}
