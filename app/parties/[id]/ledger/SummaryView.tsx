"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { t, type Lang } from "@/lib/i18n/party-ledger";

type DocumentRow = {
  targetSourceType: "BILTY" | "CHALLAN";
  targetSourceId: string;
  documentNo: string;
  documentDate: string;
  totalDue: number;
  remainingAllocatable: number;
  challanId: string | null;
  challanNo: string | null;
  biltyId: string | null;
  biltyNo: string | null;
  vehicleRegistrationNumber: string | null;
  chassisNumber: string | null;
  fromLocation: string | null;
  toLocation: string | null;
  biltyRent: number | null;
  carrierRent: number | null;
  commission: number | null;
  billNo: string | null;
  sequenceIndex: number;
};

function formatCurrency(value: number) {
  return `Rs. ${value.toLocaleString()}`;
}

// Builds exactly the human-readable line the finalized format
// specifies - each piece sourced from an existing, real field only;
// a piece is simply omitted (never faked) when that data doesn't
// exist for this Bilty (e.g. Bill No., which - per the Party Ledger
// 2.0 architecture inspection - has no backing field anywhere in
// the schema today and so never appears).
function describeBilty(row: DocumentRow): string {
  const parts: string[] = [];
  parts.push(`Bilty ${row.biltyNo}`);
  if (row.challanNo) parts.push(`Challan ${row.challanNo}`);
  if (row.vehicleRegistrationNumber) parts.push(row.vehicleRegistrationNumber);
  if (row.fromLocation && row.toLocation) parts.push(`${row.fromLocation} → ${row.toLocation}`);
  if (row.biltyRent) parts.push(`Bilty Rent ${formatCurrency(row.biltyRent)}`);
  if (row.commission) parts.push(`Commission ${formatCurrency(row.commission)}`);
  if (row.billNo) parts.push(`Bill No. ${row.billNo}`);
  return parts.join(" · ");
}

export default function SummaryView({ partyId, lang }: { partyId: string; lang: Lang }) {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setLoading(true);
        setError("");
        const response = await fetch(`/api/parties/${partyId}/documents`);
        const result = await response.json();
        if (!response.ok || !result.success) {
          setError(result.message || "Unable to load summary");
          return;
        }
        setDocuments(result.documents);
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [partyId]);

  if (loading) return <p className="text-gray-500 p-6 text-center bg-white rounded-xl shadow-sm">Loading...</p>;
  if (error) return <p className="text-red-600 p-6 text-center bg-white rounded-xl shadow-sm">{error}</p>;
  if (documents.length === 0) {
    return <p className="text-gray-500 p-10 text-center bg-white rounded-xl shadow-sm">{t("noData", lang)}</p>;
  }

  // Group by Challan, preserving the EXISTING ChallanBilty.addedAt
  // sequence within each group (already the sort order the
  // /documents API returns) - never reordered alphabetically.
  const groups = new Map<string, { challanNo: string; challanId: string | null; rows: DocumentRow[] }>();
  const standalone: DocumentRow[] = [];

  for (const row of documents) {
    if (!row.challanId) {
      standalone.push(row);
      continue;
    }
    const key = row.challanId;
    const group = groups.get(key) || { challanNo: row.challanNo || key, challanId: row.challanId, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }

  return (
    <div className="space-y-6">
      {[...groups.values()].map((group) => {
        const biltyRows = group.rows.filter((r) => r.targetSourceType === "BILTY");
        const carrierRentRow = group.rows.find((r) => r.targetSourceType === "CHALLAN");

        return (
          <div key={group.challanId} className="bg-white rounded-xl shadow-sm p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-lg">
                {t("challan", lang)}{" "}
                {group.challanId ? (
                  <Link href={`/challan/${group.challanId}`} className="text-blue-600 hover:underline">
                    {group.challanNo}
                  </Link>
                ) : (
                  group.challanNo
                )}
              </h3>
            </div>

            <ol className="space-y-3 list-decimal list-inside">
              {biltyRows.map((row) => (
                <li key={row.targetSourceId} className="text-sm">
                  <Link href={`/bilty/${row.biltyId}`} className="text-blue-600 hover:underline font-medium">
                    {describeBilty(row)}
                  </Link>
                  {row.chassisNumber && (
                    <div className="text-xs text-gray-500 ml-5">
                      {t("chassisNo", lang)} {row.chassisNumber}
                    </div>
                  )}
                </li>
              ))}
            </ol>

            {carrierRentRow && (
              <div className="mt-3 pt-3 border-t text-sm text-gray-700">
                {t("carrierRent", lang)}: <span className="font-medium">{formatCurrency(carrierRentRow.carrierRent || 0)}</span>
                <span className="text-xs text-gray-500 ml-2">
                  ({t("remaining", lang)}: {formatCurrency(carrierRentRow.remainingAllocatable)})
                </span>
              </div>
            )}
          </div>
        );
      })}

      {standalone.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm p-5">
          <h3 className="font-semibold text-lg mb-3">Other</h3>
          <ol className="space-y-3 list-decimal list-inside">
            {standalone.map((row) => (
              <li key={row.targetSourceId} className="text-sm">
                {row.targetSourceType === "BILTY" ? (
                  <Link href={`/bilty/${row.biltyId}`} className="text-blue-600 hover:underline font-medium">
                    {describeBilty(row)}
                  </Link>
                ) : (
                  <Link href={`/challan/${row.challanId}`} className="text-blue-600 hover:underline font-medium">
                    {t("challan", lang)} {row.documentNo} · {t("carrierRent", lang)} {formatCurrency(row.carrierRent || 0)}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
