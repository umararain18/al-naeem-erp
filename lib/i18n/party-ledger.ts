// ============================================================
// PARTY LEDGER 2.0 - MINIMAL CENTRALIZED TRANSLATION LAYER
//
// No i18n library exists anywhere else in this codebase (confirmed
// during the Party Ledger 2.0 architecture inspection - every other
// page's UI text is hardcoded English JSX). Rather than scatter
// language conditionals through every new component, every UI
// label for this feature is looked up here, in one place, via
// t(key, lang). This is intentionally scoped to Party Ledger 2.0
// only - it does not attempt to translate the rest of the ERP.
//
// Actual business DATA (Party names, Bilty/Challan numbers, vehicle
// registration, chassis numbers, amounts) is never translated -
// only these fixed UI labels are.
// ============================================================

export type Lang = "en" | "ur";

export const LABELS = {
  ledger: { en: "Ledger", ur: "کھاتہ" },
  summary: { en: "Summary", ur: "خلاصہ" },
  documents: { en: "Documents", ur: "دستاویزات" },
  outstanding: { en: "Outstanding", ur: "باقی رقم" },
  payments: { en: "Payments", ur: "ادائیگیاں" },
  reconciliation: { en: "Reconciliation", ur: "مطابقت" },
  statement: { en: "Statement", ur: "بیان" },

  date: { en: "Date", ur: "تاریخ" },
  description: { en: "Description", ur: "تفصیل" },
  debit: { en: "Debit", ur: "ڈیبٹ" },
  credit: { en: "Credit", ur: "کریڈٹ" },
  balance: { en: "Balance", ur: "بیلنس" },
  receivable: { en: "Receivable", ur: "وصولی" },
  payable: { en: "Payable", ur: "ادائیگی" },
  paid: { en: "Paid", ur: "ادا شدہ" },
  partial: { en: "Partial", ur: "جزوی" },
  unpaid: { en: "Unpaid", ur: "غیر ادا شدہ" },
  unallocated: { en: "Unallocated", ur: "غیر مختص" },
  allocate: { en: "Allocate", ur: "مختص کریں" },
  autoAllocate: { en: "Auto Allocate", ur: "خودکار تخصیص" },
  manualAllocation: { en: "Manual Allocation", ur: "دستی تخصیص" },
  total: { en: "Total", ur: "کل" },
  from: { en: "From", ur: "سے" },
  to: { en: "To", ur: "تک" },
  vehicle: { en: "Vehicle", ur: "گاڑی" },
  chassisNo: { en: "Chassis No.", ur: "چیسس نمبر" },
  registrationNo: { en: "Registration No.", ur: "رجسٹریشن نمبر" },
  bilty: { en: "Bilty", ur: "بلٹی" },
  challan: { en: "Challan", ur: "چالان" },
  biltyRent: { en: "Bilty Rent", ur: "بلٹی کرایہ" },
  carrierRent: { en: "Carrier Rent", ur: "گاڑی کرایہ" },
  commission: { en: "Commission", ur: "کمیشن" },
  billNo: { en: "Bill No.", ur: "بل نمبر" },
  payment: { en: "Payment", ur: "ادائیگی" },
  receipt: { en: "Receipt", ur: "رسید" },
  cash: { en: "Cash", ur: "نقد" },
  bank: { en: "Bank", ur: "بینک" },
  status: { en: "Status", ur: "حالت" },

  openingBalance: { en: "Opening Balance", ur: "ابتدائی بیلنس" },
  closingBalance: { en: "Closing Balance", ur: "اختتامی بیلنس" },
  allocated: { en: "Allocated", ur: "مختص شدہ" },
  remaining: { en: "Remaining", ur: "باقی" },
  remainingToAllocate: { en: "Remaining to Allocate", ur: "مختص کرنے کے لیے باقی" },
  source: { en: "Source", ur: "ماخذ" },
  route: { en: "Route", ur: "راستہ" },
  amount: { en: "Amount", ur: "رقم" },
  reference: { en: "Reference", ur: "حوالہ" },
  fullyAllocated: { en: "Fully Allocated", ur: "مکمل مختص" },
  partiallyAllocated: { en: "Partially Allocated", ur: "جزوی مختص" },
  fullyPaid: { en: "Fully Paid", ur: "مکمل ادا شدہ" },
  partiallyPaid: { en: "Partially Paid", ur: "جزوی ادا شدہ" },
  kisSeLenaHai: { en: "Kis Se Lena Hai", ur: "کس سے لینا ہے" },
  kisKoDenaHai: { en: "Kis Ko Dena Hai", ur: "کس کو دینا ہے" },
  statementOfAccount: { en: "Statement of Account", ur: "کھاتے کا بیان" },
  period: { en: "Period", ur: "مدت" },
  party: { en: "Party", ur: "پارٹی" },
  print: { en: "Print", ur: "پرنٹ" },
  export: { en: "Export", ur: "برآمد" },
  columns: { en: "Columns", ur: "کالم" },
  search: { en: "Search", ur: "تلاش" },
  filters: { en: "Filters", ur: "فلٹرز" },
  reset: { en: "Reset", ur: "دوبارہ ترتیب" },
  noData: { en: "No records found.", ur: "کوئی ریکارڈ نہیں ملا۔" },
  totalOutstanding: { en: "Total Outstanding", ur: "کل باقی رقم" },
  totalPayments: { en: "Total Payments", ur: "کل ادائیگیاں" },
  remainingDifference: { en: "Remaining Difference", ur: "باقی فرق" },
  edit: { en: "Edit", ur: "ترمیم" },
  remove: { en: "Remove", ur: "ہٹائیں" },
  save: { en: "Save", ur: "محفوظ کریں" },
  cancel: { en: "Cancel", ur: "منسوخ" },
  allocatedTo: { en: "Allocated to", ur: "مختص کردہ" },
} as const;

export type LabelKey = keyof typeof LABELS;

export function t(key: LabelKey, lang: Lang): string {
  return LABELS[key][lang];
}

export const LANG_STORAGE_KEY = "anc-party-ledger-lang";

export function loadStoredLang(): Lang {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(LANG_STORAGE_KEY);
    return stored === "ur" ? "ur" : "en";
  } catch {
    return "en";
  }
}

export function storeLang(lang: Lang) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // ignore storage failures (private browsing etc.)
  }
}
