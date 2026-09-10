"use client";

// Shared searchable dropdown, extracted unchanged from
// app/daily-posting/page.tsx (the Daily Posting Create form), plus
// the same canonical Document Type option list (`sourceOptions`) -
// so Edit's Document Type selector (app/cash-book/TransactionEditModal.tsx)
// offers exactly the same choices as Create, never a second,
// independently-maintained list.

import { useEffect, useMemo, useState } from "react";

export type SearchOption = {
  value: string;
  label: string;
  secondary?: string;
};

export const sourceOptions: SearchOption[] = [
  { value: "DIRECT", label: "Direct Account" },
  { value: "PARTY", label: "Party" },
  { value: "CHALLAN", label: "CN - Challan" },
  { value: "PHONCH", label: "PN - Phonch" },
  { value: "BILTY", label: "BL - Bilty" },
  { value: "BILL", label: "BI - Bill" },
];

export function SearchableSelect({
  value,
  options,
  placeholder,
  disabled = false,
  onChange,
  className = "w-full",
}: {
  value: string;
  options: SearchOption[];
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const selected = options.find((option) => option.value === value);

  useEffect(() => {
    setQuery(selected?.label || "");
  }, [value, selected?.label]);

  const filteredOptions = useMemo(() => {
    const search = query.trim().toLowerCase();
    if (!search) return options;

    return options.filter((option) =>
      `${option.label} ${option.secondary || ""}`
        .toLowerCase()
        .includes(search)
    );
  }, [options, query]);

  return (
    <div className={`relative ${className}`}>
      <input
        type="text"
        value={query}
        disabled={disabled}
        placeholder={placeholder}
        onFocus={() => {
          if (!disabled) {
            setOpen(true);
            setQuery("");
          }
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          if (value) onChange("");
        }}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 150);
        }}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500 disabled:bg-gray-100"
      />

      {open && !disabled && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-xl">
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  onChange(option.value);
                  setQuery(option.label);
                  setOpen(false);
                }}
                className="block w-full border-b border-gray-100 px-3 py-2 text-left text-sm last:border-b-0 hover:bg-blue-50"
              >
                <div className="font-medium text-gray-900">{option.label}</div>
                {option.secondary && (
                  <div className="mt-0.5 text-xs text-gray-500">{option.secondary}</div>
                )}
              </button>
            ))
          ) : (
            <div className="px-3 py-3 text-sm text-gray-500">No account found</div>
          )}
        </div>
      )}
    </div>
  );
}
