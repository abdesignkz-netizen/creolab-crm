const WEIGHTS_1 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const WEIGHTS_2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2];

export function digitsOnly(value: string) {
  return String(value || "").replace(/\D+/g, "");
}

function controlDigit(first11: number[]) {
  let sum = 0;
  for (let i = 0; i < 11; i += 1) sum += first11[i] * WEIGHTS_1[i];
  let control = sum % 11;
  if (control === 10) {
    sum = 0;
    for (let i = 0; i < 11; i += 1) sum += first11[i] * WEIGHTS_2[i];
    control = sum % 11;
    if (control === 10) return null;
  }
  return control;
}

/** БИН / ИИН РК: 12 цифр и контрольная цифра. */
export function isValidKzTaxId(value: string | null | undefined) {
  const digits = digitsOnly(String(value || ""));
  if (digits.length !== 12) return false;
  const nums = digits.split("").map(Number);
  if (nums.some((n) => !Number.isInteger(n))) return false;
  const control = controlDigit(nums.slice(0, 11));
  return control != null && control === nums[11];
}

export function normalizeKzTaxId(value: string | null | undefined) {
  const digits = digitsOnly(String(value || ""));
  return digits || null;
}
