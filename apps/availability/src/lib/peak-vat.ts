// PEAK's VAT type for every product line FolkOPS sends. Folkpaths is not registered for VAT,
// and PEAK now refuses a document whose lines leave it unset: "Merchant is not registered for
// VAT, product vatType must be 1." (from 31 Oct 2026 — the same documents went through on
// 26 Oct). The documents PEAK already holds read back as vatType 1. PEAK_VAT_TYPE overrides
// it, for the day the company registers for VAT.
export const PEAK_VAT_TYPE: number = Number(process.env.PEAK_VAT_TYPE) || 1;
