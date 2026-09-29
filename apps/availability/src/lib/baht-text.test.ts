import { describe, expect, it } from "vitest";
import { bahtText } from "./baht-text";

describe("the amount in Thai words", () => {
  it("reads a round amount and closes it with ถ้วน", () => {
    expect(bahtText(1000)).toBe("หนึ่งพันบาทถ้วน");
    expect(bahtText(2000)).toBe("สองพันบาทถ้วน");
  });

  it("reads สิบ and ยี่สิบ the way Thai does, not digit by digit", () => {
    expect(bahtText(10)).toBe("สิบบาทถ้วน");
    expect(bahtText(20)).toBe("ยี่สิบบาทถ้วน");
    expect(bahtText(30)).toBe("สามสิบบาทถ้วน");
  });

  it("uses เอ็ด for a trailing one above ten", () => {
    expect(bahtText(21)).toBe("ยี่สิบเอ็ดบาทถ้วน");
    expect(bahtText(101)).toBe("หนึ่งร้อยเอ็ดบาทถ้วน");
    expect(bahtText(1)).toBe("หนึ่งบาทถ้วน");
  });

  it("chains ล้าน", () => {
    expect(bahtText(1_000_000)).toBe("หนึ่งล้านบาทถ้วน");
    expect(bahtText(1_234_567)).toBe("หนึ่งล้านสองแสนสามหมื่นสี่พันห้าร้อยหกสิบเจ็ดบาทถ้วน");
  });

  it("reads satang as their own number", () => {
    expect(bahtText(1500.5)).toBe("หนึ่งพันห้าร้อยบาทห้าสิบสตางค์");
    expect(bahtText(0.25)).toBe("ยี่สิบห้าสตางค์");
  });

  it("rounds to satang, so a float tail never reaches the page", () => {
    expect(bahtText(0.1 + 0.2)).toBe("สามสิบสตางค์");
    expect(bahtText(99.999)).toBe("หนึ่งร้อยบาทถ้วน");
  });

  it("says zero rather than nothing", () => {
    expect(bahtText(0)).toBe("ศูนย์บาทถ้วน");
  });

  it("marks a negative amount instead of hiding the sign", () => {
    expect(bahtText(-500)).toBe("ลบห้าร้อยบาทถ้วน");
  });

  it("returns an empty string for a number that is not one", () => {
    expect(bahtText(Number.NaN)).toBe("");
  });
});
