// WebAuthn (passkey) config — Face ID / fingerprint sign-in.
// rpID must equal the site domain; origin its https URL. Passkeys registered on
// guide.folkpaths.com only work there (that's the canonical domain).
export const RP_NAME = "Folkpaths";
export const RP_ID = process.env.PASSKEY_RP_ID || "guide.folkpaths.com";
export const ORIGIN = process.env.PASSKEY_ORIGIN || "https://guide.folkpaths.com";
export const CHALLENGE_COOKIE = "wa_chal";
