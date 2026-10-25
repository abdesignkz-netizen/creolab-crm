/** Detailed analyses stay bounded. The extra row proves that the result is
 * incomplete; callers must return this information in the UI and exports. */
export class AnalyticsCoverage {
  private sections = new Map<string, { key: string; label: string; loaded: number; atLeast: number | null; status: "partial" | "unavailable" }>();

  async read<T>(key: string, label: string, limit: number, load: (take: number) => PromiseLike<T[]>): Promise<T[]> {
    const rows = await load(limit + 1);
    if (rows.length > limit) this.sections.set(key, { key, label, loaded: limit, atLeast: rows.length, status: "partial" });
    return rows.slice(0, limit);
  }

  unavailable(key: string, label: string) {
    this.sections.set(key, { key, label, loaded: 0, atLeast: null, status: "unavailable" });
  }

  result() {
    const sections = [...this.sections.values()].sort((a, b) => a.key.localeCompare(b.key));
    return { partial: sections.length > 0, sections };
  }
}
