"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

type Slip = {
  id: string;
  slipNo: string;
  departureDate: string;
  returnDate: string | null;
  route: string | null;
  status: string;
  linkedChallan: { challanNo: string } | null;
  linkedBilty: { biltyNo: string } | null;
  financials: { totalBiltyRent: number; carrierRent: number; totalExpenses: number; carrierProfit: number; officeCommission: number };
};

type CarrierDetail = {
  carrier: { id: string; carrierNumber: string; driverName: string | null; driverPhone: string | null; isActive: boolean };
  slips: Slip[];
  summary: { slipCount: number; totalCarrierRent: number; totalExpenses: number; totalProfit: number; remainingDriverCash: number };
  permissions: { canEdit: boolean; canBin: boolean; canCreateSlip: boolean };
};

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}
function formatDate(value: string) {
  return new Date(value).toLocaleDateString("en-PK", { day: "2-digit", month: "short", year: "numeric" });
}

export default function CarrierFolderPage() {
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<CarrierDetail | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    const res = await fetch(`/api/own-carriers/${params.id}`);
    const json = await res.json();
    if (json.success) setData(json);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  if (loading) return <div className="p-6 text-sm text-gray-500">Loading...</div>;
  if (!data) return <div className="p-6 text-sm text-red-600">Carrier not found.</div>;

  const { carrier, slips, summary, permissions } = data;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <Link href="/own-carrier" className="text-sm text-gray-500 hover:text-gray-800">
        ← All carriers
      </Link>
      <div className="flex items-start justify-between mt-3 mb-6">
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-gray-500">Carrier Folder</div>
          <h1 className="text-2xl font-bold text-gray-900 mt-1">{carrier.carrierNumber}</h1>
          <p className="text-sm text-gray-500 mt-1">Driver: {carrier.driverName || "—"} {carrier.driverPhone ? `· ${carrier.driverPhone}` : ""}</p>
        </div>
        {permissions.canCreateSlip && (
          <Link
            href={`/own-carrier/${carrier.id}/slip/new`}
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-semibold text-white hover:bg-gray-800"
          >
            + New Trip Slip
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">Trip Slips</div>
          <div className="text-xl font-bold mt-1">{summary.slipCount}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">Total Carrier Rent</div>
          <div className="text-xl font-bold mt-1">Rs. {formatMoney(summary.totalCarrierRent)}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">Carrier Profit</div>
          <div className="text-xl font-bold mt-1 text-green-700">Rs. {formatMoney(summary.totalProfit)}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">Driver Cash (operational, Phase 1)</div>
          <div className="text-xl font-bold mt-1">Rs. {formatMoney(summary.remainingDriverCash)}</div>
        </div>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left p-3">Slip</th>
                <th className="text-left p-3">Departure / Return</th>
                <th className="text-left p-3">Challan / Bilty</th>
                <th className="text-right p-3">Carrier Rent</th>
                <th className="text-right p-3">Expenses</th>
                <th className="text-right p-3">Profit</th>
                <th className="text-left p-3">Status</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {slips.length === 0 ? (
                <tr>
                  <td colSpan={8} className="p-6 text-center text-gray-500">
                    No trip slips yet.
                  </td>
                </tr>
              ) : (
                slips.map((s) => (
                  <tr key={s.id} className="border-t border-gray-100 hover:bg-gray-50">
                    <td className="p-3 font-semibold">#{s.slipNo}</td>
                    <td className="p-3">
                      {formatDate(s.departureDate)} {s.returnDate ? `→ ${formatDate(s.returnDate)}` : ""}
                    </td>
                    <td className="p-3 text-gray-600">{s.linkedChallan?.challanNo || s.linkedBilty?.biltyNo || "—"}</td>
                    <td className="p-3 text-right">{formatMoney(s.financials.carrierRent)}</td>
                    <td className="p-3 text-right">{formatMoney(s.financials.totalExpenses)}</td>
                    <td className="p-3 text-right font-semibold text-green-700">{formatMoney(s.financials.carrierProfit)}</td>
                    <td className="p-3">
                      <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">{s.status.replace("_", " ")}</span>
                    </td>
                    <td className="p-3 text-right">
                      <Link href={`/own-carrier/${carrier.id}/slip/${s.id}`} className="text-blue-600 hover:underline">
                        View
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <p className="text-xs text-gray-400 mt-2">
        Financial status (Cleared / Receivable / Payable) is separate from trip status (In Progress / Trip Completed / Returned).
      </p>
    </div>
  );
}
