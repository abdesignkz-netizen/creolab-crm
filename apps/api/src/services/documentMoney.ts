export function moneyRound(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function lineAmounts(quantity: number, unitPrice: number, vatRate: number) {
  const amountWithoutVat = moneyRound(quantity * unitPrice);
  const vatAmount = moneyRound((amountWithoutVat * vatRate) / 100);
  return {
    amountWithoutVat,
    vatAmount,
    totalAmount: moneyRound(amountWithoutVat + vatAmount),
  };
}

export function sumLines(
  items: Array<{ amountWithoutVat: number; vatAmount: number; totalAmount: number; vatRate: number }>,
) {
  const amountWithoutVat = moneyRound(items.reduce((sum, item) => sum + item.amountWithoutVat, 0));
  const vatAmount = moneyRound(items.reduce((sum, item) => sum + item.vatAmount, 0));
  const totalAmount = moneyRound(items.reduce((sum, item) => sum + item.totalAmount, 0));
  const rates = [...new Set(items.map((item) => item.vatRate))];
  return {
    amountWithoutVat,
    vatAmount,
    totalAmount,
    vatRate: rates.length === 1 ? rates[0] : null,
  };
}

export function asMoney(value: { toString(): string } | number | null | undefined) {
  if (value == null) return 0;
  const n = Number(typeof value === "number" ? value : value.toString());
  return Number.isFinite(n) ? n : 0;
}

export function toMinorTenge(amount: number) {
  return Math.round(amount);
}
