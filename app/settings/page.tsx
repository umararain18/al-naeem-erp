"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";

// ============================================================
// CENTRAL SETTINGS - Business Details / Branding / Header & Footer /
// Document Settings / Invoice / PDF & Print.
//
// One page, a left mini-nav switching which section's form is shown on
// the right (per the task's own preferred layout) - never a separate
// sidebar item per setting. Each section has its OWN Save button and
// PATCHes only that section's fields (app/api/settings/business or
// app/api/settings/document-types) - never a single mega-form, and
// never resets fields the user isn't currently editing.
//
// Read-only for anyone without settings.edit (MANAGER, per
// lib/permissions.ts) - forms render disabled and Save is hidden,
// exactly mirroring how app/accounts/page.tsx gates system-account
// editing.
// ============================================================

type DocumentTypeSettingRow = {
  id: string;
  documentType: string;
  useHeader: boolean | null;
  useFooter: boolean | null;
  useLogo: boolean | null;
};

type BusinessSettings = {
  id: string;
  businessName: string;
  legalName: string | null;
  shortName: string | null;
  phone1: string | null;
  phone2: string | null;
  whatsapp: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  country: string | null;
  ntnNumber: string | null;
  registrationNumber: string | null;

  mainLogoUrl: string | null;
  smallLogoUrl: string | null;
  faviconUrl: string | null;
  signatureUrl: string | null;
  stampUrl: string | null;
  brandPrimaryColor: string | null;
  brandSecondaryColor: string | null;

  headerShowLogo: boolean;
  headerShowBusinessName: boolean;
  headerShowAddress: boolean;
  headerShowPhone: boolean;
  headerShowWhatsapp: boolean;
  headerShowEmail: boolean;
  headerShowWebsite: boolean;
  headerLogoPosition: "LEFT" | "CENTER" | "RIGHT";
  headerAlignment: "LEFT" | "CENTER" | "RIGHT";
  headerSubtitle: string | null;
  defaultUseHeader: boolean;
  defaultUseFooter: boolean;
  defaultUseLogo: boolean;

  footerText: string | null;
  footerShowPhone: boolean;
  footerShowAddress: boolean;
  footerShowWebsite: boolean;
  footerShowPageNumber: boolean;
  footerShowGeneratedDate: boolean;
  termsAndConditions: string | null;

  invoiceTitle: string;
  invoiceNumberPrefix: string | null;
  currencyLabel: string;
  paymentInstructions: string | null;
  defaultTermsAndConditions: string | null;
  authorizedByLabel: string;
  signatureLabel: string;

  pdfPageSize: "A4" | "A5";
  pdfOrientation: "PORTRAIT" | "LANDSCAPE";
  pdfDefaultFont: string | null;
  pdfDefaultFontSize: number;
  pdfTableBorderStyle: string | null;
  pdfShowWatermark: boolean;
  pdfWatermarkText: string | null;
  pdfShowPageNumber: boolean;
  pdfShowGeneratedDate: boolean;

  documentTypeSettings: DocumentTypeSettingRow[];
};

type SectionKey = "business" | "branding" | "header-footer" | "documents" | "invoice" | "pdf";

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "business", label: "Business Details" },
  { key: "branding", label: "Branding" },
  { key: "header-footer", label: "Header & Footer" },
  { key: "documents", label: "Documents" },
  { key: "invoice", label: "Invoice" },
  { key: "pdf", label: "PDF & Print" },
];

const DOCUMENT_TYPE_LABELS: Record<string, string> = {
  BILTY: "Bilty",
  CHALLAN: "Challan",
  BILL: "Bill",
  PRIVATE_PHONCH: "Private Phonch",
  SHOWROOM_PHONCH: "Showroom Phonch",
  RECEIPT: "Receipt",
  PARTY_STATEMENT: "Party Statement",
  REPORTS: "Reports",
};
const DOCUMENT_TYPES_ORDER = Object.keys(DOCUMENT_TYPE_LABELS);

function TextField({
  label,
  value,
  onChange,
  disabled,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
      <input
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
      />
    </div>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  disabled,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  rows?: number;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
      <textarea
        value={value}
        disabled={disabled}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
      />
    </div>
  );
}

function ToggleField({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-gray-700">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 rounded border-gray-300"
      />
      {label}
    </label>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled: boolean;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100 disabled:text-gray-500"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function SaveBar({ saving, canEdit, onSave, message }: { saving: boolean; canEdit: boolean; onSave: () => void; message: string }) {
  if (!canEdit) {
    return <p className="text-sm text-gray-500">You have read-only access to Settings.</p>;
  }
  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={onSave}
        disabled={saving}
        className="rounded-lg bg-black px-4 py-2 text-sm text-white hover:bg-gray-800 disabled:opacity-50"
      >
        {saving ? "Saving..." : "Save Changes"}
      </button>
      {message && <span className="text-sm text-green-700">{message}</span>}
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<BusinessSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeSection, setActiveSection] = useState<SectionKey>("business");

  async function load() {
    try {
      setError("");
      const res = await fetch("/api/settings/business", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.message || "Unable to load settings");
        return;
      }
      setSettings(data.settings);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  // GET /api/settings/business succeeds for BOTH SUPER_ADMIN and
  // MANAGER (settings.view covers both, per lib/permissions.ts), so
  // whether editing is actually allowed can't be inferred from that
  // response alone. PATCH is SUPER_ADMIN-only (settings.edit) - the
  // same role this app's own /api/auth/me endpoint already exposes for
  // exactly this kind of role-gated UI (see its own doc comment).
  // Every Save button is still independently enforced server-side
  // regardless of what this flag shows.
  const [role, setRole] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setRole(d?.user?.role || null))
      .catch(() => {});
  }, []);
  const editable = role === "SUPER_ADMIN";

  useEffect(() => {
    void load();
  }, []);

  if (loading) {
    return <main className="min-h-screen bg-gray-50 p-6 text-sm text-gray-500">Loading settings...</main>;
  }

  if (error || !settings) {
    return (
      <main className="min-h-screen bg-gray-50 p-6">
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error || "Unable to load settings"}
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50 p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="mt-1 text-sm text-gray-500">
            Business identity, branding, document header/footer, invoice, and PDF/print configuration.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 md:grid-cols-4">
          <nav className="rounded-xl border bg-white p-2 shadow-sm md:col-span-1">
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setActiveSection(s.key)}
                className={`block w-full rounded-lg px-3 py-2 text-left text-sm ${
                  activeSection === s.key ? "bg-black text-white" : "text-gray-700 hover:bg-gray-50"
                }`}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="md:col-span-3">
            {activeSection === "business" && (
              <BusinessDetailsSection settings={settings} editable={editable} onSaved={setSettings} />
            )}
            {activeSection === "branding" && <BrandingSection settings={settings} editable={editable} onSaved={setSettings} />}
            {activeSection === "header-footer" && (
              <HeaderFooterSection settings={settings} editable={editable} onSaved={setSettings} />
            )}
            {activeSection === "documents" && (
              <DocumentsSection settings={settings} editable={editable} onSaved={setSettings} />
            )}
            {activeSection === "invoice" && <InvoiceSection settings={settings} editable={editable} onSaved={setSettings} />}
            {activeSection === "pdf" && <PdfSection settings={settings} editable={editable} onSaved={setSettings} />}
          </div>
        </div>
      </div>
    </main>
  );
}

async function patchBusiness(payload: Record<string, unknown>): Promise<{ success: boolean; message?: string; settings?: BusinessSettings }> {
  const res = await fetch("/api/settings/business", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
}

// ------------------------------------------------------------
// BUSINESS DETAILS
// ------------------------------------------------------------
function BusinessDetailsSection({
  settings,
  editable,
  onSaved,
}: {
  settings: BusinessSettings;
  editable: boolean;
  onSaved: (s: BusinessSettings) => void;
}) {
  const [form, setForm] = useState({
    businessName: settings.businessName,
    legalName: settings.legalName || "",
    shortName: settings.shortName || "",
    phone1: settings.phone1 || "",
    phone2: settings.phone2 || "",
    whatsapp: settings.whatsapp || "",
    email: settings.email || "",
    website: settings.website || "",
    address: settings.address || "",
    city: settings.city || "",
    province: settings.province || "",
    country: settings.country || "",
    ntnNumber: settings.ntnNumber || "",
    registrationNumber: settings.registrationNumber || "",
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError("");
    setMessage("");
    const result = await patchBusiness(form);
    if (!result.success) {
      setError(result.message || "Unable to save");
    } else {
      setMessage("Saved.");
      if (result.settings) onSaved(result.settings);
    }
    setSaving(false);
  }

  return (
    <section className="rounded-xl border bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900">Business Details</h2>
      <p className="mt-1 text-sm text-gray-500">Your registered business identity, used across future documents.</p>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField label="Business Name" value={form.businessName} onChange={(v) => set("businessName", v)} disabled={!editable} />
        <TextField label="Legal / Registered Name" value={form.legalName} onChange={(v) => set("legalName", v)} disabled={!editable} />
        <TextField label="Short Name" value={form.shortName} onChange={(v) => set("shortName", v)} disabled={!editable} />
        <TextField label="Phone 1" value={form.phone1} onChange={(v) => set("phone1", v)} disabled={!editable} />
        <TextField label="Phone 2" value={form.phone2} onChange={(v) => set("phone2", v)} disabled={!editable} />
        <TextField label="WhatsApp" value={form.whatsapp} onChange={(v) => set("whatsapp", v)} disabled={!editable} />
        <TextField label="Email" value={form.email} onChange={(v) => set("email", v)} disabled={!editable} type="email" />
        <TextField label="Website" value={form.website} onChange={(v) => set("website", v)} disabled={!editable} placeholder="https://..." />
        <TextField label="City" value={form.city} onChange={(v) => set("city", v)} disabled={!editable} />
        <TextField label="Province" value={form.province} onChange={(v) => set("province", v)} disabled={!editable} />
        <TextField label="Country" value={form.country} onChange={(v) => set("country", v)} disabled={!editable} />
        <TextField label="NTN / Tax Number" value={form.ntnNumber} onChange={(v) => set("ntnNumber", v)} disabled={!editable} />
        <TextField
          label="Registration Number"
          value={form.registrationNumber}
          onChange={(v) => set("registrationNumber", v)}
          disabled={!editable}
        />
        <div className="md:col-span-2">
          <TextAreaField label="Address" value={form.address} onChange={(v) => set("address", v)} disabled={!editable} />
        </div>
      </div>

      <div className="mt-6">
        <SaveBar saving={saving} canEdit={editable} onSave={save} message={message} />
      </div>
    </section>
  );
}

// ------------------------------------------------------------
// BRANDING
// ------------------------------------------------------------
function BrandingUpload({
  label,
  field,
  currentUrl,
  editable,
  onUpdated,
}: {
  label: string;
  field: "mainLogo" | "smallLogo" | "favicon" | "signature" | "stamp";
  currentUrl: string | null;
  editable: boolean;
  onUpdated: (s: BusinessSettings) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function upload(file: File) {
    setBusy(true);
    setError("");
    const formData = new FormData();
    formData.set("field", field);
    formData.set("file", file);
    const res = await fetch("/api/settings/branding/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (!data.success) setError(data.message || "Upload failed");
    else onUpdated(data.settings);
    setBusy(false);
  }

  async function remove() {
    setBusy(true);
    setError("");
    const res = await fetch(`/api/settings/branding/upload?field=${field}`, { method: "DELETE" });
    const data = await res.json();
    if (!data.success) setError(data.message || "Remove failed");
    else onUpdated(data.settings);
    setBusy(false);
  }

  return (
    <div className="rounded-lg border p-4">
      <p className="text-sm font-medium text-gray-700">{label}</p>
      <div className="mt-3 flex items-center gap-4">
        <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded border bg-gray-50">
          {currentUrl ? (
            <Image src={currentUrl} alt={label} width={64} height={64} className="h-full w-full object-contain" unoptimized />
          ) : (
            <span className="text-xs text-gray-400">None</span>
          )}
        </div>
        {editable && (
          <div className="flex flex-col gap-2">
            <input
              ref={inputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="rounded border px-3 py-1 text-xs hover:bg-gray-50 disabled:opacity-50"
            >
              {currentUrl ? "Replace" : "Upload"}
            </button>
            {currentUrl && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove()}
                className="rounded border border-red-200 px-3 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Remove
              </button>
            )}
          </div>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function BrandingSection({
  settings,
  editable,
  onSaved,
}: {
  settings: BusinessSettings;
  editable: boolean;
  onSaved: (s: BusinessSettings) => void;
}) {
  const [colors, setColors] = useState({
    brandPrimaryColor: settings.brandPrimaryColor || "#000000",
    brandSecondaryColor: settings.brandSecondaryColor || "#666666",
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function saveColors() {
    setSaving(true);
    setError("");
    setMessage("");
    const result = await patchBusiness(colors);
    if (!result.success) setError(result.message || "Unable to save");
    else {
      setMessage("Saved.");
      if (result.settings) onSaved(result.settings);
    }
    setSaving(false);
  }

  return (
    <section className="rounded-xl border bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900">Branding</h2>
      <p className="mt-1 text-sm text-gray-500">Logos, signature, stamp, and brand colors.</p>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <BrandingUpload label="Main Logo" field="mainLogo" currentUrl={settings.mainLogoUrl} editable={editable} onUpdated={onSaved} />
        <BrandingUpload
          label="Small Logo / Logo Mark"
          field="smallLogo"
          currentUrl={settings.smallLogoUrl}
          editable={editable}
          onUpdated={onSaved}
        />
        <BrandingUpload label="Favicon" field="favicon" currentUrl={settings.faviconUrl} editable={editable} onUpdated={onSaved} />
        <BrandingUpload
          label="Authorized Signature"
          field="signature"
          currentUrl={settings.signatureUrl}
          editable={editable}
          onUpdated={onSaved}
        />
        <BrandingUpload label="Stamp" field="stamp" currentUrl={settings.stampUrl} editable={editable} onUpdated={onSaved} />
      </div>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Brand Primary Color</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={colors.brandPrimaryColor}
              disabled={!editable}
              onChange={(e) => setColors((c) => ({ ...c, brandPrimaryColor: e.target.value }))}
              className="h-9 w-14 rounded border disabled:opacity-50"
            />
            <span className="text-sm text-gray-500">{colors.brandPrimaryColor}</span>
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Brand Secondary Color</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={colors.brandSecondaryColor}
              disabled={!editable}
              onChange={(e) => setColors((c) => ({ ...c, brandSecondaryColor: e.target.value }))}
              className="h-9 w-14 rounded border disabled:opacity-50"
            />
            <span className="text-sm text-gray-500">{colors.brandSecondaryColor}</span>
          </div>
        </div>
      </div>

      <div className="mt-6">
        <SaveBar saving={saving} canEdit={editable} onSave={saveColors} message={message} />
      </div>
    </section>
  );
}

// ------------------------------------------------------------
// HEADER & FOOTER (with live preview)
// ------------------------------------------------------------
function HeaderFooterSection({
  settings,
  editable,
  onSaved,
}: {
  settings: BusinessSettings;
  editable: boolean;
  onSaved: (s: BusinessSettings) => void;
}) {
  const [form, setForm] = useState({
    headerShowLogo: settings.headerShowLogo,
    headerShowBusinessName: settings.headerShowBusinessName,
    headerShowAddress: settings.headerShowAddress,
    headerShowPhone: settings.headerShowPhone,
    headerShowWhatsapp: settings.headerShowWhatsapp,
    headerShowEmail: settings.headerShowEmail,
    headerShowWebsite: settings.headerShowWebsite,
    headerLogoPosition: settings.headerLogoPosition,
    headerAlignment: settings.headerAlignment,
    headerSubtitle: settings.headerSubtitle || "",
    footerText: settings.footerText || "",
    footerShowPhone: settings.footerShowPhone,
    footerShowAddress: settings.footerShowAddress,
    footerShowWebsite: settings.footerShowWebsite,
    footerShowPageNumber: settings.footerShowPageNumber,
    footerShowGeneratedDate: settings.footerShowGeneratedDate,
    termsAndConditions: settings.termsAndConditions || "",
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError("");
    setMessage("");
    const result = await patchBusiness(form);
    if (!result.success) setError(result.message || "Unable to save");
    else {
      setMessage("Saved.");
      if (result.settings) onSaved(result.settings);
    }
    setSaving(false);
  }

  const alignClass = form.headerAlignment === "LEFT" ? "text-left" : form.headerAlignment === "RIGHT" ? "text-right" : "text-center";
  const logoOrderClass = form.headerLogoPosition === "RIGHT" ? "order-last" : form.headerLogoPosition === "CENTER" ? "mx-auto" : "";

  return (
    <section className="rounded-xl border bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900">Header & Footer</h2>
      <p className="mt-1 text-sm text-gray-500">What appears at the top and bottom of generated documents.</p>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-5 grid grid-cols-1 gap-6 md:grid-cols-2">
        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">Header</h3>
          <div className="grid grid-cols-2 gap-2">
            <ToggleField label="Show Logo" checked={form.headerShowLogo} onChange={(v) => set("headerShowLogo", v)} disabled={!editable} />
            <ToggleField
              label="Show Business Name"
              checked={form.headerShowBusinessName}
              onChange={(v) => set("headerShowBusinessName", v)}
              disabled={!editable}
            />
            <ToggleField
              label="Show Address"
              checked={form.headerShowAddress}
              onChange={(v) => set("headerShowAddress", v)}
              disabled={!editable}
            />
            <ToggleField label="Show Phone" checked={form.headerShowPhone} onChange={(v) => set("headerShowPhone", v)} disabled={!editable} />
            <ToggleField
              label="Show WhatsApp"
              checked={form.headerShowWhatsapp}
              onChange={(v) => set("headerShowWhatsapp", v)}
              disabled={!editable}
            />
            <ToggleField label="Show Email" checked={form.headerShowEmail} onChange={(v) => set("headerShowEmail", v)} disabled={!editable} />
            <ToggleField
              label="Show Website"
              checked={form.headerShowWebsite}
              onChange={(v) => set("headerShowWebsite", v)}
              disabled={!editable}
            />
          </div>
          <SelectField
            label="Logo Position"
            value={form.headerLogoPosition}
            onChange={(v) => set("headerLogoPosition", v as typeof form.headerLogoPosition)}
            options={[
              { value: "LEFT", label: "Left" },
              { value: "CENTER", label: "Center" },
              { value: "RIGHT", label: "Right" },
            ]}
            disabled={!editable}
          />
          <SelectField
            label="Header Alignment"
            value={form.headerAlignment}
            onChange={(v) => set("headerAlignment", v as typeof form.headerAlignment)}
            options={[
              { value: "LEFT", label: "Left" },
              { value: "CENTER", label: "Center" },
              { value: "RIGHT", label: "Right" },
            ]}
            disabled={!editable}
          />
          <TextField label="Header Subtitle" value={form.headerSubtitle} onChange={(v) => set("headerSubtitle", v)} disabled={!editable} />
        </div>

        <div className="space-y-4">
          <h3 className="text-sm font-semibold text-gray-700">Footer</h3>
          <TextAreaField label="Footer Text" value={form.footerText} onChange={(v) => set("footerText", v)} disabled={!editable} rows={2} />
          <div className="grid grid-cols-2 gap-2">
            <ToggleField label="Show Phone" checked={form.footerShowPhone} onChange={(v) => set("footerShowPhone", v)} disabled={!editable} />
            <ToggleField
              label="Show Address"
              checked={form.footerShowAddress}
              onChange={(v) => set("footerShowAddress", v)}
              disabled={!editable}
            />
            <ToggleField
              label="Show Website"
              checked={form.footerShowWebsite}
              onChange={(v) => set("footerShowWebsite", v)}
              disabled={!editable}
            />
            <ToggleField
              label="Show Page Number"
              checked={form.footerShowPageNumber}
              onChange={(v) => set("footerShowPageNumber", v)}
              disabled={!editable}
            />
            <ToggleField
              label="Show Generated Date"
              checked={form.footerShowGeneratedDate}
              onChange={(v) => set("footerShowGeneratedDate", v)}
              disabled={!editable}
            />
          </div>
          <TextAreaField
            label="Terms & Conditions"
            value={form.termsAndConditions}
            onChange={(v) => set("termsAndConditions", v)}
            disabled={!editable}
          />
        </div>
      </div>

      {/* Live preview - UI-only, matching the ASCII mockup in the spec, never a full PDF render */}
      <div className="mt-6">
        <h3 className="mb-2 text-sm font-semibold text-gray-700">Preview</h3>
        <div className="rounded-lg border bg-gray-50 p-4 text-sm">
          <div className={`flex items-center gap-3 border-b pb-3 ${alignClass}`}>
            {form.headerShowLogo && (
              <div className={`flex h-10 w-10 items-center justify-center rounded border bg-white text-[10px] text-gray-400 ${logoOrderClass}`}>
                LOGO
              </div>
            )}
            <div>
              {form.headerShowBusinessName && <p className="font-semibold text-gray-900">{settings.businessName || "Your Business Name"}</p>}
              {form.headerSubtitle && <p className="text-xs text-gray-500">{form.headerSubtitle}</p>}
              <p className="text-xs text-gray-500">
                {[form.headerShowPhone && settings.phone1, form.headerShowWhatsapp && settings.whatsapp, form.headerShowEmail && settings.email]
                  .filter(Boolean)
                  .join(" | ")}
              </p>
              {form.headerShowAddress && (
                <p className="text-xs text-gray-500">{[settings.city, settings.province, settings.country].filter(Boolean).join(", ")}</p>
              )}
            </div>
          </div>
          <div className="py-4 text-center text-xs text-gray-400">Document content preview</div>
          <div className="border-t pt-3 text-center text-xs text-gray-500">
            {form.footerText && <p>{form.footerText}</p>}
            <p>
              {[form.footerShowPhone && settings.phone1 && `Phone: ${settings.phone1}`, form.footerShowAddress && settings.address].filter(Boolean).join(" · ")}
            </p>
            {(form.footerShowPageNumber || form.footerShowGeneratedDate) && (
              <p>{[form.footerShowPageNumber && "Page 1", form.footerShowGeneratedDate && new Date().toLocaleDateString()].filter(Boolean).join(" · ")}</p>
            )}
          </div>
        </div>
      </div>

      <div className="mt-6">
        <SaveBar saving={saving} canEdit={editable} onSave={save} message={message} />
      </div>
    </section>
  );
}

// ------------------------------------------------------------
// DOCUMENT SETTINGS
// ------------------------------------------------------------
type TriState = "INHERIT" | "ON" | "OFF";
function toTriState(v: boolean | null | undefined): TriState {
  if (v === true) return "ON";
  if (v === false) return "OFF";
  return "INHERIT";
}
function fromTriState(v: TriState): boolean | null {
  if (v === "ON") return true;
  if (v === "OFF") return false;
  return null;
}

function DocumentsSection({
  settings,
  editable,
  onSaved,
}: {
  settings: BusinessSettings;
  editable: boolean;
  onSaved: (s: BusinessSettings) => void;
}) {
  const [rows, setRows] = useState<Record<string, { useHeader: TriState; useFooter: TriState; useLogo: TriState }>>(() => {
    const initial: Record<string, { useHeader: TriState; useFooter: TriState; useLogo: TriState }> = {};
    for (const type of DOCUMENT_TYPES_ORDER) {
      const existing = settings.documentTypeSettings.find((d) => d.documentType === type);
      initial[type] = {
        useHeader: toTriState(existing?.useHeader),
        useFooter: toTriState(existing?.useFooter),
        useLogo: toTriState(existing?.useLogo),
      };
    }
    return initial;
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function setRow(type: string, field: "useHeader" | "useFooter" | "useLogo", value: TriState) {
    setRows((r) => ({ ...r, [type]: { ...r[type], [field]: value } }));
  }

  async function save() {
    setSaving(true);
    setError("");
    setMessage("");
    const entries = DOCUMENT_TYPES_ORDER.map((type) => ({
      documentType: type,
      useHeader: fromTriState(rows[type].useHeader),
      useFooter: fromTriState(rows[type].useFooter),
      useLogo: fromTriState(rows[type].useLogo),
    }));
    const res = await fetch("/api/settings/document-types", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    const data = await res.json();
    if (!data.success) {
      setError(data.message || "Unable to save");
    } else {
      setMessage("Saved.");
      onSaved({ ...settings, documentTypeSettings: data.documentTypeSettings });
    }
    setSaving(false);
  }

  const triOptions = [
    { value: "INHERIT", label: "Use Global Default" },
    { value: "ON", label: "On" },
    { value: "OFF", label: "Off" },
  ];

  return (
    <section className="rounded-xl border bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900">Document Settings</h2>
      <p className="mt-1 text-sm text-gray-500">
        Per-document Header/Footer/Logo overrides. Global defaults (Header & Footer section) apply unless explicitly set here.
      </p>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-5 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
            <tr>
              <th className="px-3 py-2">Document</th>
              <th className="px-3 py-2">Use Header</th>
              <th className="px-3 py-2">Use Footer</th>
              <th className="px-3 py-2">Use Logo</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {DOCUMENT_TYPES_ORDER.map((type) => (
              <tr key={type}>
                <td className="px-3 py-2 font-medium">{DOCUMENT_TYPE_LABELS[type]}</td>
                {(["useHeader", "useFooter", "useLogo"] as const).map((field) => (
                  <td key={field} className="px-3 py-2">
                    <select
                      value={rows[type][field]}
                      disabled={!editable}
                      onChange={(e) => setRow(type, field, e.target.value as TriState)}
                      className="rounded-lg border bg-white px-2 py-1 text-xs outline-none focus:border-blue-500 disabled:bg-gray-100"
                    >
                      {triOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-6">
        <SaveBar saving={saving} canEdit={editable} onSave={save} message={message} />
      </div>
    </section>
  );
}

// ------------------------------------------------------------
// INVOICE / BILL SETTINGS
// ------------------------------------------------------------
function InvoiceSection({
  settings,
  editable,
  onSaved,
}: {
  settings: BusinessSettings;
  editable: boolean;
  onSaved: (s: BusinessSettings) => void;
}) {
  const [form, setForm] = useState({
    invoiceTitle: settings.invoiceTitle,
    invoiceNumberPrefix: settings.invoiceNumberPrefix || "",
    currencyLabel: settings.currencyLabel,
    paymentInstructions: settings.paymentInstructions || "",
    defaultTermsAndConditions: settings.defaultTermsAndConditions || "",
    authorizedByLabel: settings.authorizedByLabel,
    signatureLabel: settings.signatureLabel,
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function set<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError("");
    setMessage("");
    const result = await patchBusiness(form);
    if (!result.success) setError(result.message || "Unable to save");
    else {
      setMessage("Saved.");
      if (result.settings) onSaved(result.settings);
    }
    setSaving(false);
  }

  return (
    <section className="rounded-xl border bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900">Invoice / Bill Settings</h2>
      <p className="mt-1 text-sm text-gray-500">
        Display preferences only - this does not change Bill numbering or accounting behavior.
      </p>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <TextField label="Bill / Invoice Title" value={form.invoiceTitle} onChange={(v) => set("invoiceTitle", v)} disabled={!editable} placeholder="BILL" />
        <TextField label="Number Prefix" value={form.invoiceNumberPrefix} onChange={(v) => set("invoiceNumberPrefix", v)} disabled={!editable} />
        <TextField label="Currency" value={form.currencyLabel} onChange={(v) => set("currencyLabel", v)} disabled={!editable} placeholder="Rs." />
        <TextField label="Authorized By Label" value={form.authorizedByLabel} onChange={(v) => set("authorizedByLabel", v)} disabled={!editable} />
        <TextField label="Signature Label" value={form.signatureLabel} onChange={(v) => set("signatureLabel", v)} disabled={!editable} />
        <div className="md:col-span-2">
          <TextAreaField
            label="Payment Instructions"
            value={form.paymentInstructions}
            onChange={(v) => set("paymentInstructions", v)}
            disabled={!editable}
          />
        </div>
        <div className="md:col-span-2">
          <TextAreaField
            label="Default Terms & Conditions"
            value={form.defaultTermsAndConditions}
            onChange={(v) => set("defaultTermsAndConditions", v)}
            disabled={!editable}
          />
        </div>
      </div>

      <div className="mt-6">
        <SaveBar saving={saving} canEdit={editable} onSave={save} message={message} />
      </div>
    </section>
  );
}

// ------------------------------------------------------------
// PDF & PRINT SETTINGS
// ------------------------------------------------------------
function PdfSection({
  settings,
  editable,
  onSaved,
}: {
  settings: BusinessSettings;
  editable: boolean;
  onSaved: (s: BusinessSettings) => void;
}) {
  const [form, setForm] = useState({
    pdfPageSize: settings.pdfPageSize,
    pdfOrientation: settings.pdfOrientation,
    pdfDefaultFont: settings.pdfDefaultFont || "",
    pdfDefaultFontSize: settings.pdfDefaultFontSize,
    pdfTableBorderStyle: settings.pdfTableBorderStyle || "",
    pdfShowWatermark: settings.pdfShowWatermark,
    pdfWatermarkText: settings.pdfWatermarkText || "",
    pdfShowPageNumber: settings.pdfShowPageNumber,
    pdfShowGeneratedDate: settings.pdfShowGeneratedDate,
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function save() {
    setSaving(true);
    setError("");
    setMessage("");
    const result = await patchBusiness(form);
    if (!result.success) setError(result.message || "Unable to save");
    else {
      setMessage("Saved.");
      if (result.settings) onSaved(result.settings);
    }
    setSaving(false);
  }

  return (
    <section className="rounded-xl border bg-white p-6 shadow-sm">
      <h2 className="text-lg font-semibold text-gray-900">PDF & Print Settings</h2>
      <p className="mt-1 text-sm text-gray-500">Defaults for newly generated PDF/print documents.</p>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <SelectField
          label="Page Size"
          value={form.pdfPageSize}
          onChange={(v) => set("pdfPageSize", v as typeof form.pdfPageSize)}
          options={[
            { value: "A4", label: "A4" },
            { value: "A5", label: "A5" },
          ]}
          disabled={!editable}
        />
        <SelectField
          label="Orientation"
          value={form.pdfOrientation}
          onChange={(v) => set("pdfOrientation", v as typeof form.pdfOrientation)}
          options={[
            { value: "PORTRAIT", label: "Portrait" },
            { value: "LANDSCAPE", label: "Landscape" },
          ]}
          disabled={!editable}
        />
        <TextField label="Default Font" value={form.pdfDefaultFont} onChange={(v) => set("pdfDefaultFont", v)} disabled={!editable} />
        <TextField
          label="Default Font Size"
          type="number"
          value={String(form.pdfDefaultFontSize)}
          onChange={(v) => set("pdfDefaultFontSize", Number(v) || settings.pdfDefaultFontSize)}
          disabled={!editable}
        />
        <TextField
          label="Table Border Style"
          value={form.pdfTableBorderStyle}
          onChange={(v) => set("pdfTableBorderStyle", v)}
          disabled={!editable}
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-2 md:grid-cols-3">
        <ToggleField label="Show Watermark" checked={form.pdfShowWatermark} onChange={(v) => set("pdfShowWatermark", v)} disabled={!editable} />
        <ToggleField
          label="Show Page Number"
          checked={form.pdfShowPageNumber}
          onChange={(v) => set("pdfShowPageNumber", v)}
          disabled={!editable}
        />
        <ToggleField
          label="Show Generated Date"
          checked={form.pdfShowGeneratedDate}
          onChange={(v) => set("pdfShowGeneratedDate", v)}
          disabled={!editable}
        />
      </div>

      {form.pdfShowWatermark && (
        <div className="mt-4">
          <TextField label="Watermark Text" value={form.pdfWatermarkText} onChange={(v) => set("pdfWatermarkText", v)} disabled={!editable} />
        </div>
      )}

      <div className="mt-6">
        <SaveBar saving={saving} canEdit={editable} onSave={save} message={message} />
      </div>
    </section>
  );
}
