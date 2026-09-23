// The amount in Thai words, as every Thai accounting document carries it.
//
// It is written out because figures can be altered and words cannot — the line
// "หนึ่งพันบาทถ้วน" under ฿1,000.00 is what makes a voucher hard to tamper with, and
// an auditor expects to find it. The reading rules are the fiddly part:
//
//   ๑๐  สิบ, not หนึ่งสิบ          ๒๐  ยี่สิบ, not สองสิบ
//   ๒๑  ยี่สิบเอ็ด, not ยี่สิบหนึ่ง   ๑๐๑ หนึ่งร้อยเอ็ด
//
// Satang are read as their own number: 1,500.50 → หนึ่งพันห้าร้อยบาทห้าสิบสตางค์.
// An amount with no satang ends in ถ้วน, which means "exactly" and closes the line
// so nothing can be appended to it.

const DIGITS = ["", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
const PLACES = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];

/** 1–999,999 in words. Callers handle zero and millions. */
function readGroup(n: number): string {
  let out = "";
  const s = String(n);
  for (let i = 0; i < s.length; i++) {
    const digit = Number(s[i]);
    const place = s.length - 1 - i;
    if (digit === 0) continue;
    if (place === 1 && digit === 1) out += PLACES[1];           // สิบ
    else if (place === 1 && digit === 2) out += "ยี่" + PLACES[1]; // ยี่สิบ
    else if (place === 0 && digit === 1 && n > 9) out += "เอ็ด";  // ยี่สิบเอ็ด
    else out += DIGITS[digit] + PLACES[place];
  }
  return out;
}

/** Whole numbers of any size, chaining ล้าน the way Thai does. */
function readNumber(n: number): string {
  if (n === 0) return "ศูนย์";
  if (n < 1_000_000) return readGroup(n);
  return readNumber(Math.floor(n / 1_000_000)) + "ล้าน" + (n % 1_000_000 ? readGroup(n % 1_000_000) : "");
}

/**
 * `bahtText(1000)` → "หนึ่งพันบาทถ้วน" · `bahtText(1500.5)` → "หนึ่งพันห้าร้อยบาทห้าสิบสตางค์"
 *
 * Rounds to satang first, so a float that arrives as 0.1 + 0.2 still reads as
 * thirty satang rather than something with a tail.
 */
export function bahtText(amount: number): string {
  if (!Number.isFinite(amount)) return "";
  const negative = amount < 0;
  const total = Math.round(Math.abs(amount) * 100);
  const baht = Math.floor(total / 100);
  const satang = total % 100;
  let words: string;
  if (baht === 0 && satang === 0) words = "ศูนย์บาทถ้วน";
  else if (satang === 0) words = `${readNumber(baht)}บาทถ้วน`;
  else if (baht === 0) words = `${readNumber(satang)}สตางค์`;
  else words = `${readNumber(baht)}บาท${readNumber(satang)}สตางค์`;
  return negative ? `ลบ${words}` : words;
}
