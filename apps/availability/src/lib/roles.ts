// Central role predicates. ACCOUNTANT is a freelance finance role: can VIEW the
// money screens and record the PEAK accounting ref, but cannot run operations,
// mark payments, upload e-slips, or delete anything (the operator does payments).
export const isOps = (r?: string | null) => r === "OPERATOR" || r === "ADMIN";
export const isAccountant = (r?: string | null) => r === "ACCOUNTANT";
export const canViewFinance = (r?: string | null) => isOps(r) || isAccountant(r);
