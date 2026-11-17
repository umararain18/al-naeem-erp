// Canonical "03XXXXXXXXX" local-mobile key for the Marketing module (and
// the Bilty form's own sender-phone validation) - digits-only, last-10
// must start with "3" (a Pakistani mobile number), returned as
// "0" + those 10 digits. Deliberately NOT the same shape normalizePhone()
// above returns ("+92XXXXXXXXXX") - that one is this app's existing
// general-purpose phone normalizer (unchanged), this one is the single
// canonical dedupe/validation key every Marketing contact/lookup uses.
export function toLocalMobile(phone: string | null | undefined): string | null {
  if (!phone) return null;

  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return null;

  const last10 = digits.slice(-10);
  if (!last10.startsWith("3")) return null;

  return `0${last10}`;
}

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
