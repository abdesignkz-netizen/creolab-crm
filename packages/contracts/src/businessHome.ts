export type HomeModule<T> = { status: "ready" | "unavailable" | "hidden"; items: T[] };
export type HomeInsight = { id: string; title: string; detail: string; limitation: string; href: string; asOf: string; urgent: boolean };
export type HomeGoal = { id: string; title: string; progress: number | null; reached: boolean | null; stale: boolean; ended: boolean; asOf: string | null; href: string };
export type HomeAction = { id: string; title: string; status: string; completed: number; steps: number; at: string; href: string };
/** Bounded, freshly authorized company context; amounts come from the existing overview. */
export type BusinessHomeFocus = {
  asOf: string; scope: "company" | "personal";
  insights: HomeModule<HomeInsight> & { scannedAt: string | null; sampled: true };
  goals: HomeModule<HomeGoal>;
  actions: HomeModule<HomeAction> & { recent: HomeAction[] };
};
