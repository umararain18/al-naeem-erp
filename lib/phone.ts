export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;

  const digits = phone.replace(/\D/g, "");

  if (digits.length === 0) return null;

  if (digits.startsWith("92") && digits.length === 13) {
    return `+${digits}`;
  }

  if (digits.startsWith("0") && digits.length === 11) {
    return `+92${digits.slice(1)}`;
  }

  if (digits.startsWith("3") && digits.length === 10) {
    return `+92${digits}`;
  }

  if (digits.length >= 10 && digits.length <= 13) {
    return `+${digits}`;
  }

  return null;
}
