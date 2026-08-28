// WebAuthn (passkey) config — Face ID / fingerprint sign-in.
//
// DO NOT wire these to PUBLIC_BASE_URL. Everything else that names the site follows
// that variable so the domain can be changed with one setting — these must not.
// A passkey is cryptographically bound to its Relying Party ID: change RP_ID and
// EVERY passkey guides have already registered stops working, permanently. They
// cannot be migrated; every guide would have to re-enrol.
//
// So renaming the site is safe, but it leaves passkeys on the old domain until a
// deliberate migration. To move them, set PASSKEY_RP_ID / PASSKEY_ORIGIN — and
// accept that existing credentials die at that moment.
export const RP_NAME = "Folkpaths";
export const RP_ID = process.env.PASSKEY_RP_ID || "guide.folkpaths.com";
export const ORIGIN = process.env.PASSKEY_ORIGIN || "https://guide.folkpaths.com";
export const CHALLENGE_COOKIE = "wa_chal";
