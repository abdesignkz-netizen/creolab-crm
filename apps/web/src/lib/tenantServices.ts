export type TenantService = { kind: "SERVICE" | "PRODUCT"; code: string; name: string; description: string; aliases: string[]; active: boolean };

export const catalogItemLabel = (item: Pick<TenantService, "name" | "kind">) => `${item.name} · ${item.kind === "PRODUCT" ? "Товар" : "Услуга"}`;
