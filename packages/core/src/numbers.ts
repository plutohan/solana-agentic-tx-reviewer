/**
 * Convert an integer base-unit string into a UI float using `decimals`, without
 * float subtraction. The RPC's uiAmount can be null (large amounts / odd mints),
 * so callers derive from the raw `amount` string instead.
 */
export function rawToUi(raw: string, decimals: number): number {
  if (decimals <= 0) return Number(raw);
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const intPart = digits.slice(0, digits.length - decimals);
  const fracPart = digits.slice(digits.length - decimals);
  const value = Number(`${intPart}.${fracPart}`);
  return negative ? -value : value;
}
