/** A bounded, factual Control response. Suggestions are never execution results. */
export type ControlProfile = "business" | "sales" | "finance" | "team" | "service";
export type ControlAnalysisCard = {
  kind: "facts" | "insight" | "goal" | "decision";
  title: string; text: string; href: string; asOf: string;
};
export type ControlAnalysis = {
  profile: ControlProfile; title: string; asOf: string; timezone: string;
  summary: string; cards: ControlAnalysisCard[]; limitations: string[];
  suggestion: { title: string; steps: string[]; href: string; command: string } | null;
  plan: { id: string; href: string; status: string; completed: number; stepCount: number } | null;
  budget: { reads: number; maxReads: number; modelCalls: 0; elapsedMs: number; limited: boolean };
};
