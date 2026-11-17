import { toLocalMobile } from "./phone";

// ============================================================
// BILTY CREATE - EFFECTIVE SENDER PHONE RESOLUTION
//
// Pure decision tree for app/api/bilty/route.ts's own "RESOLVE
// EFFECTIVE SENDER PHONE" step. Priority: (1) an explicitly-typed
// phone, validated - garbage is always rejected, never silently
// overridden by a Party's own phone. (2) if left blank and a Party is
// selected, auto-fill from that Party's own phone, then whatsapp (first
// one that normalizes). (3) if still nothing usable, the walk-in
// "customer didn't give a number" escape hatch (noPhoneProvided) -
// explicit, never inferred from a merely-blank field. Never used by the
// EDIT route (app/api/bilty/[id]/route.ts stays untouched, optional).
// ============================================================

export interface ResolveBiltySenderPhoneInput {
  typedPhone: string; // raw form value, possibly empty
  partyPhone: string | null; // selected consignor Party's own phone, if any
  partyWhatsapp: string | null;
  noPhoneProvided: boolean; // the create form's own checkbox
}

export type ResolveBiltySenderPhoneResult =
  | { ok: true; phone: string | null; noPhoneProvided: boolean }
  | { ok: false; message: string };

export function resolveBiltySenderPhone(input: ResolveBiltySenderPhoneInput): ResolveBiltySenderPhoneResult {
  const typed = input.typedPhone.trim();

  if (typed !== "") {
    if (toLocalMobile(typed) === null) {
      return { ok: false, message: "Enter a valid mobile number (e.g. 03XXXXXXXXX)" };
    }
    return { ok: true, phone: typed, noPhoneProvided: false };
  }

  if (input.partyPhone && toLocalMobile(input.partyPhone) !== null) {
    return { ok: true, phone: input.partyPhone, noPhoneProvided: false };
  }
  if (input.partyWhatsapp && toLocalMobile(input.partyWhatsapp) !== null) {
    return { ok: true, phone: input.partyWhatsapp, noPhoneProvided: false };
  }

  if (input.noPhoneProvided) {
    return { ok: true, phone: null, noPhoneProvided: true };
  }

  return { ok: false, message: "Sender mobile number is required" };
}
