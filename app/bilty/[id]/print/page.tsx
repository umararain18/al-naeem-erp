"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";

type BiltyStatus = "PENDING" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED";

type Location = {
  id: string;
  name: string;
};

type Party = {
  id: string;
  partyName: string;
};

type AgentParty = {
  id: string;
  partyName: string;
  account: {
    id: string;
    accountName: string;
    accountCode: string | null;
    accountType: string;
    category: string;
    isActive: boolean;
  } | null;
};

type Creator = {
  id: string;
  fullName: string;
  username: string;
};

type Bilty = {
  id: string;
  biltyNo: string;
  date: string;
  status: BiltyStatus;
  fromLocation: Location;
  toLocation: Location;
  consignorParty: Party | null;
  consignorName: string;
  consignorPhone: string | null;
  consigneeParty: Party | null;
  consigneeName: string;
  consigneePhone: string | null;
  clearingAgentParty: Party | null;
  clearingAgentName: string | null;
  vehicleType: string | null;
  vehicleModel: string | null;
  vehicleColor: string | null;
  engineNumber: string | null;
  chassisNumber: string | null;
  registrationNumber: string | null;
  rent: number | null;
  insurance: number | null;
  expense: number | null;
  total: number | null;
  advance: number | null;
  toPay: number | null;
  agentParty: AgentParty | null;
  agentCommission: number | null;
  agentDescription: string | null;
  notes: string | null;
  createdBy: Creator | null;
  createdAt: string;
};

const statusLabels: Record<BiltyStatus, string> = {
  PENDING: "Pending",
  IN_TRANSIT: "In Transit",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

export default function BiltyPrintPage() {
  const params = useParams<{ id: string }>();
  const [bilty, setBilty] = useState<Bilty | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setError("");

        const response = await fetch(`/api/bilty/${params.id}`);

        const data = await response.json();

        if (!response.ok) {
          setError(data.message || "Unable to load bilty");
          return;
        }

        setBilty(data.bilty);
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [params.id]);

  useEffect(() => {
    if (!loading && !error && bilty) {
      const timeout = setTimeout(() => {
        window.print();
      }, 300);

      return () => clearTimeout(timeout);
    }
  }, [loading, error, bilty]);

  if (loading) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <p className="text-gray-500">Loading bilty...</p>
      </div>
    );
  }

  if (error || !bilty) {
    return (
      <div className="min-h-screen bg-white flex items-center justify-center">
        <div className="text-center">
          <p className="text-red-600 mb-4">{error || "Bilty not found"}</p>
          <Link
            href={`/bilty/${params.id}`}
            className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
          >
            Back to Bilty
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white">
      <div className="max-w-[210mm] mx-auto p-8">
        {/* Header */}

        <div className="text-center border-b-2 border-black pb-4 mb-6">
          <h1 className="text-2xl font-bold uppercase tracking-wide">Al Naeem Car Carriers Service</h1>
          <p className="text-lg font-semibold mt-1">BILTY</p>
        </div>

        <div className="flex justify-between items-start mb-6">
          <div>
            <p className="text-sm font-semibold">Bilty No:</p>
            <p className="text-base font-bold">{bilty.biltyNo}</p>
          </div>

          <div className="text-right">
            <p className="text-sm font-semibold">Date:</p>
            <p className="text-base">{new Date(bilty.date).toLocaleDateString()}</p>
          </div>

          <div className="text-right">
            <p className="text-sm font-semibold">Status:</p>
            <p className="text-base font-semibold">{statusLabels[bilty.status]}</p>
          </div>
        </div>

        {/* Route */}

        <div className="border border-black rounded-lg p-4 mb-6">
          <p className="text-sm font-semibold text-center mb-2">Route</p>
          <p className="text-xl font-bold text-center">
            {bilty.fromLocation.name} <span className="mx-3">→</span> {bilty.toLocation.name}
          </p>
        </div>

        {/* Consignor / Consignee */}

        <div className="grid grid-cols-2 gap-6 mb-6">
          <div className="border border-black rounded-lg p-4">
            <p className="text-sm font-semibold border-b border-black pb-1 mb-3">Consignor</p>
            <div className="space-y-2 text-sm">
              <div>
                <p className="text-xs text-gray-600">Party:</p>
                <p className="font-medium">{bilty.consignorParty?.partyName || "-"}</p>
              </div>
              <div>
                <p className="text-xs text-gray-600">Name:</p>
                <p className="font-medium">{bilty.consignorName}</p>
              </div>
              <div>
                <p className="text-xs text-gray-600">Phone:</p>
                <p className="font-medium">{bilty.consignorPhone || "-"}</p>
              </div>
            </div>
          </div>

          <div className="border border-black rounded-lg p-4">
            <p className="text-sm font-semibold border-b border-black pb-1 mb-3">Consignee</p>
            <div className="space-y-2 text-sm">
              <div>
                <p className="text-xs text-gray-600">Party:</p>
                <p className="font-medium">{bilty.consigneeParty?.partyName || "-"}</p>
              </div>
              <div>
                <p className="text-xs text-gray-600">Name:</p>
                <p className="font-medium">{bilty.consigneeName}</p>
              </div>
              <div>
                <p className="text-xs text-gray-600">Phone:</p>
                <p className="font-medium">{bilty.consigneePhone || "-"}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Clearing Agent */}

        <div className="border border-black rounded-lg p-4 mb-6">
          <p className="text-sm font-semibold border-b border-black pb-1 mb-3">Clearing Agent / Delivery Point</p>
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-xs text-gray-600">Name:</p>
              <p className="font-medium">{bilty.clearingAgentName || "-"}</p>
            </div>
            <div>
              <p className="text-xs text-gray-600">Party:</p>
              <p className="font-medium">{bilty.clearingAgentParty?.partyName || "-"}</p>
            </div>
          </div>
        </div>

        {/* Vehicle Details */}

        <div className="border border-black rounded-lg p-4 mb-6">
          <p className="text-sm font-semibold border-b border-black pb-1 mb-3">Vehicle Details</p>
          <div className="grid grid-cols-2 gap-4 text-sm">
            {bilty.vehicleType && (
              <div>
                <p className="text-xs text-gray-600">Type:</p>
                <p className="font-medium">{bilty.vehicleType}</p>
              </div>
            )}
            {bilty.vehicleModel && (
              <div>
                <p className="text-xs text-gray-600">Model:</p>
                <p className="font-medium">{bilty.vehicleModel}</p>
              </div>
            )}
            {bilty.vehicleColor && (
              <div>
                <p className="text-xs text-gray-600">Color:</p>
                <p className="font-medium">{bilty.vehicleColor}</p>
              </div>
            )}
            {bilty.registrationNumber && (
              <div>
                <p className="text-xs text-gray-600">Registration Number:</p>
                <p className="font-medium">{bilty.registrationNumber}</p>
              </div>
            )}
            {bilty.engineNumber && (
              <div>
                <p className="text-xs text-gray-600">Engine Number:</p>
                <p className="font-medium">{bilty.engineNumber}</p>
              </div>
            )}
            {bilty.chassisNumber && (
              <div>
                <p className="text-xs text-gray-600">Chassis Number:</p>
                <p className="font-medium">{bilty.chassisNumber}</p>
              </div>
            )}
            {!bilty.vehicleType &&
              !bilty.vehicleModel &&
              !bilty.vehicleColor &&
              !bilty.registrationNumber &&
              !bilty.engineNumber &&
              !bilty.chassisNumber && (
                <p className="text-sm text-gray-500 col-span-2">No vehicle details provided.</p>
              )}
          </div>
        </div>

        {/* Financial Summary */}

        <div className="border border-black rounded-lg p-4 mb-6">
          <p className="text-sm font-semibold border-b border-black pb-1 mb-3">Financial Summary</p>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-gray-600">Rent</span>
              <span>Rs. {Number(bilty.rent || 0).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Insurance</span>
              <span>Rs. {Number(bilty.insurance || 0).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Expense</span>
              <span>Rs. {Number(bilty.expense || 0).toLocaleString()}</span>
            </div>
            <div className="border-t border-black pt-1 flex justify-between font-semibold">
              <span>Total</span>
              <span>Rs. {Number(bilty.total || 0).toLocaleString()}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Advance</span>
              <span>Rs. {Number(bilty.advance || 0).toLocaleString()}</span>
            </div>
            <div className="border-t-2 border-black pt-1 flex justify-between font-bold text-lg">
              <span>To Pay</span>
              <span>Rs. {Number(bilty.toPay || 0).toLocaleString()}</span>
            </div>
          </div>
        </div>

        {/* Commission / Referral */}

        {(bilty.agentParty || (bilty.agentCommission ?? 0) > 0 || bilty.agentDescription) && (
          <div className="border border-black rounded-lg p-4 mb-6">
            <p className="text-sm font-semibold border-b border-black pb-1 mb-3">Commission / Referral</p>
            <div className="space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-600">Agent / Referral Party</span>
                <span>{bilty.agentParty?.partyName || "-"}</span>
              </div>
              {bilty.agentParty?.account && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Account</span>
                  <span>{bilty.agentParty.account.accountName} ({bilty.agentParty.account.accountCode || "N/A"})</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-600">Commission</span>
                <span>Rs. {Number(bilty.agentCommission || 0).toLocaleString()}</span>
              </div>
              {bilty.agentDescription && (
                <div className="flex justify-between">
                  <span className="text-gray-600">Description</span>
                  <span>{bilty.agentDescription}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Notes */}

        {bilty.notes && (
          <div className="border border-black rounded-lg p-4 mb-6">
            <p className="text-sm font-semibold border-b border-black pb-1 mb-2">Notes</p>
            <p className="text-sm whitespace-pre-line">{bilty.notes}</p>
          </div>
        )}

        {/* Signatures */}

        <div className="grid grid-cols-3 gap-6 mt-12 mb-8">
          <div className="border-t border-black pt-2 text-center">
            <p className="text-sm font-medium">Received By</p>
          </div>
          <div className="border-t border-black pt-2 text-center">
            <p className="text-sm font-medium">Driver Signature</p>
          </div>
          <div className="border-t border-black pt-2 text-center">
            <p className="text-sm font-medium">Authorized Signature</p>
          </div>
        </div>

        {/* Actions */}

        <div className="flex justify-between items-center pt-6 border-t border-gray-200">
          <Link
            href={`/bilty/${params.id}`}
            className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
          >
            Back to Bilty
          </Link>
          <button
            type="button"
            onClick={() => window.print()}
            className="bg-black text-white rounded-lg px-4 py-2 text-sm hover:bg-gray-800"
          >
            Print Again
          </button>
        </div>
      </div>
    </div>
  );
}
