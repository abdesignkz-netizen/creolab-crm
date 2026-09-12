const ONES = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const ONES_F = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const TEENS = [
  "десять",
  "одиннадцать",
  "двенадцать",
  "тринадцать",
  "четырнадцать",
  "пятнадцать",
  "шестнадцать",
  "семнадцать",
  "восемнадцать",
  "девятнадцать",
];
const TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];

function triad(n: number, feminine: boolean) {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) words.push(HUNDREDS[hundreds]);
  if (rest >= 10 && rest < 20) {
    words.push(TEENS[rest - 10]);
    return words;
  }
  const tens = Math.floor(rest / 10);
  const ones = rest % 10;
  if (tens) words.push(TENS[tens]);
  if (ones) words.push((feminine ? ONES_F : ONES)[ones]);
  return words;
}

function plural(n: number, forms: [string, string, string]) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

function intToWords(value: number) {
  if (value === 0) return "ноль";
  const parts: string[] = [];
  const millions = Math.floor(value / 1_000_000);
  const thousands = Math.floor((value % 1_000_000) / 1000);
  const rest = value % 1000;
  if (millions) {
    parts.push(...triad(millions, false), plural(millions, ["миллион", "миллиона", "миллионов"]));
  }
  if (thousands) {
    parts.push(...triad(thousands, true), plural(thousands, ["тысяча", "тысячи", "тысяч"]));
  }
  if (rest || parts.length === 0) parts.push(...triad(rest, false));
  return parts.filter(Boolean).join(" ");
}

/** Сумма прописью для тенге. */
export function amountToKztWords(amount: number) {
  const safe = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  const tenge = Math.floor(safe + 1e-9);
  const tiyn = Math.round((safe - tenge) * 100);
  const tengeWords = intToWords(tenge);
  const tengeUnit = plural(tenge, ["тенге", "тенге", "тенге"]);
  if (tiyn <= 0) return `${tengeWords} ${tengeUnit}`;
  const tiynWords = intToWords(tiyn);
  const tiynUnit = plural(tiyn, ["тиын", "тиына", "тиынов"]);
  return `${tengeWords} ${tengeUnit} ${tiynWords} ${tiynUnit}`;
}
