"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { getBiltyShareMessage } from "@/lib/share-messages";
import { normalizePhone } from "@/lib/phone";

type BiltyStatus = "PENDING" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED";

type Location = {
  id: string;
  name: string;
};

type Party = {
  id: string;
  partyName: string;
  phone?: string | null;
  whatsapp?: string | null;
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

const statusColors: Record<BiltyStatus, string> = {
  PENDING: "text-yellow-600",
  IN_TRANSIT: "text-blue-600",
  DELIVERED: "text-green-600",
  CANCELLED: "text-red-600",
};

export default function BiltyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const routeParams = useParams();
  const [bilty, setBilty] = useState<Bilty | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function load() {
      try {
        setError("");

        const response = await fetch("/api/bilty");

        const data = await response.json();

        if (!response.ok) {
          setError(data.message || "Unable to load bilty");
          return;
        }

        const { id } = await params;
        const found = data.bilties.find((b: Bilty) => b.id === id);

        if (!found) {
          setError("Bilty not found");
          return;
        }

        setBilty(found);
      } catch {
        setError("Unable to connect to the server");
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [params]);

  if (loading) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-4xl mx-auto p-6">
          <p className="text-gray-500">Loading bilty...</p>
        </div>
      </main>
    );
  }

  if (error || !bilty) {
    return (
      <main className="min-h-screen bg-gray-50">
        <div className="max-w-4xl mx-auto p-6">
          <p className="text-red-600">{error || "Bilty not found"}</p>
          <Link
            href="/bilty"
            className="mt-4 inline-block border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
          >
            Back to Bilty
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto p-6">
        {/* Header */}

        <div className="mb-6">
          <div className="text-xs text-gray-500 mb-1">Al Naeem Car Carriers Service</div>
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
            <div>
              <h1 className="text-2xl font-bold">Bilty #{bilty.biltyNo}</h1>
              <p className="text-gray-600">
                {new Date(bilty.date).toLocaleDateString()}
              </p>
            </div>

            <div className="flex items-center gap-3">
              <span
                className={`text-sm font-medium ${statusColors[bilty.status]}`}
              >
                {bilty.status.replace("_", " ")}
              </span>

              <Link
                href="/bilty"
                className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
              >
                Back to Bilty
              </Link>

              <Link
                href="/bilty"
                className="bg-black text-white rounded-lg px-4 py-2 text-sm hover:bg-gray-800"
              >
                Edit
              </Link>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          {/* Route */}

          <section className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold mb-4">Route</h2>
            <div className="flex items-center gap-2 text-lg">
              <span className="font-medium">{bilty.fromLocation.name}</span>
              <span className="text-gray-400">→</span>
              <span className="font-medium">{bilty.toLocation.name}</span>
            </div>
          </section>

          {/* Consignor */}

          <section className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold mb-4">Consignor</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Party</p>
                <p className="text-sm mt-1">
                  {bilty.consignorParty?.partyName || "-"}
                </p>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Name</p>
                <p className="text-sm mt-1">{bilty.consignorName}</p>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Phone</p>
                <p className="text-sm mt-1">{bilty.consignorPhone || "-"}</p>
              </div>
            </div>
          </section>

          {/* Consignee */}

          <section className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold mb-4">Consignee</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Party</p>
                <p className="text-sm mt-1">
                  {bilty.consigneeParty?.partyName || "-"}
                </p>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Name</p>
                <p className="text-sm mt-1">{bilty.consigneeName}</p>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Phone</p>
                <p className="text-sm mt-1">{bilty.consigneePhone || "-"}</p>
              </div>
            </div>
          </section>

          {/* Clearing Agent / Delivery Point */}

          <section className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold mb-4">Clearing Agent / Delivery Point</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Name</p>
                <p className="text-sm mt-1">{bilty.clearingAgentName || "-"}</p>
              </div>

              <div>
                <p className="text-xs text-gray-500 uppercase tracking-wide">Party</p>
                <p className="text-sm mt-1">
                  {bilty.clearingAgentParty?.partyName || "-"}
                </p>
              </div>
            </div>
          </section>

          {/* Vehicle Details */}

          <section className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold mb-4">Vehicle Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {bilty.vehicleType && (
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Type</p>
                  <p className="text-sm mt-1">{bilty.vehicleType}</p>
                </div>
              )}

              {bilty.vehicleModel && (
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Model</p>
                  <p className="text-sm mt-1">{bilty.vehicleModel}</p>
                </div>
              )}

              {bilty.vehicleColor && (
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Color</p>
                  <p className="text-sm mt-1">{bilty.vehicleColor}</p>
                </div>
              )}

              {bilty.registrationNumber && (
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Registration Number</p>
                  <p className="text-sm mt-1">{bilty.registrationNumber}</p>
                </div>
              )}

              {bilty.engineNumber && (
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Engine Number</p>
                  <p className="text-sm mt-1">{bilty.engineNumber}</p>
                </div>
              )}

              {bilty.chassisNumber && (
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Chassis Number</p>
                  <p className="text-sm mt-1">{bilty.chassisNumber}</p>
                </div>
              )}

              {!bilty.vehicleType &&
                !bilty.vehicleModel &&
                !bilty.vehicleColor &&
                !bilty.registrationNumber &&
                !bilty.engineNumber &&
                !bilty.chassisNumber && (
                  <p className="text-sm text-gray-500 md:col-span-2">
                    No vehicle details provided.
                  </p>
                )}
            </div>
          </section>

          {/* Financial Summary */}

          <section className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold mb-4">Financial Summary</h2>
            <div className="space-y-2 text-sm">
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
              <div className="border-t pt-2 flex justify-between font-semibold">
                <span>Total</span>
                <span>Rs. {Number(bilty.total || 0).toLocaleString()}</span>
              </div>
              <div className="border-t pt-2 flex justify-between">
                <span className="text-gray-600">Advance</span>
                <span>Rs. {Number(bilty.advance || 0).toLocaleString()}</span>
              </div>
              <div className="border-t pt-2 flex justify-between font-semibold text-lg">
                <span>To Pay</span>
                <span>Rs. {Number(bilty.toPay || 0).toLocaleString()}</span>
              </div>
            </div>
          </section>

          {/* Commission / Referral */}

          {(bilty.agentParty || (bilty.agentCommission ?? 0) > 0 || bilty.agentDescription) && (
            <section className="bg-white rounded-xl shadow-sm p-6">
              <h2 className="text-lg font-semibold mb-4">Commission / Referral</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Agent / Referral Party</p>
                  <p className="mt-1">{bilty.agentParty?.partyName || "-"}</p>
                  {bilty.agentParty?.account && (
                    <p className="text-xs text-gray-500">
                      Account: {bilty.agentParty.account.accountName} ({bilty.agentParty.account.accountCode || "N/A"})
                    </p>
                  )}
                </div>

                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Commission</p>
                  <p className="mt-1">Rs. {Number(bilty.agentCommission || 0).toLocaleString()}</p>
                </div>

                {bilty.agentDescription && (
                  <div className="md:col-span-2">
                    <p className="text-xs text-gray-500 uppercase tracking-wide">Description</p>
                    <p className="mt-1">{bilty.agentDescription}</p>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Notes */}

          {bilty.notes && (
            <section className="bg-white rounded-xl shadow-sm p-6">
              <h2 className="text-lg font-semibold mb-4">Notes</h2>
              <p className="text-sm whitespace-pre-line">{bilty.notes}</p>
            </section>
          )}

          {/* Audit Information */}

          {bilty.createdBy && (
            <section className="bg-white rounded-xl shadow-sm p-6">
              <h2 className="text-lg font-semibold mb-4">Audit Information</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs text-gray-500 uppercase tracking-wide">Created By</p>
                  <p className="mt-1">{bilty.createdBy.fullName || bilty.createdBy.username}</p>
                  <p className="text-xs text-gray-500">
                    {new Date(bilty.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
            </section>
          )}

           {/* Actions */}

           {error && <p className="text-sm text-red-600 mb-4">{error}</p>}

           <div className="flex flex-col sm:flex-row gap-3">
             <Link
               href="/bilty"
               className="flex-1 border rounded-lg px-4 py-3 text-center text-sm hover:bg-gray-50"
             >
               Back to Bilty
             </Link>
             <Link
               href="/bilty"
               className="flex-1 bg-black text-white rounded-lg px-4 py-3 text-center text-sm hover:bg-gray-800"
             >
               Edit
             </Link>
             <button
               type="button"
               onClick={() => {
                 window.location.href = `/bilty/${routeParams.id}/print`;
               }}
               className="flex-1 border rounded-lg px-4 py-3 text-sm hover:bg-gray-50"
             >
               Print
             </button>
             <button
               type="button"
               onClick={async () => {
                 if (!bilty) return;
                 try {
                   setError("");
                   const response = await fetch(`/api/bilty/${routeParams.id}/pdf`);
                   if (!response.ok) {
                     const data = await response.json().catch(() => ({}));
                     setError(data.message || "Unable to download PDF");
                     return;
                   }
                   const blob = await response.blob();
                   const url = window.URL.createObjectURL(blob);
                   const a = document.createElement("a");
                   a.href = url;
                   a.download = `Bilty-${bilty.biltyNo}.pdf`;
                   document.body.appendChild(a);
                   a.click();
                   document.body.removeChild(a);
                   window.URL.revokeObjectURL(url);
                 } catch {
                   setError("Unable to connect to the server");
                 }
               }}
               className="flex-1 border rounded-lg px-4 py-3 text-sm hover:bg-gray-50"
             >
               Download PDF
             </button>
             <button
               type="button"
               onClick={async () => {
                 if (!bilty) return;
                 try {
                   setError("");
                   const response = await fetch(`/api/bilty/${routeParams.id}/pdf`);
                   if (!response.ok) {
                     const data = await response.json().catch(() => ({}));
                     setError(data.message || "Unable to share PDF");
                     return;
                   }
                   const blob = await response.blob();
                   const file = new File([blob], `Bilty-${bilty.biltyNo}.pdf`, { type: "application/pdf" });

                   if (navigator.canShare && navigator.canShare({ files: [file] })) {
                     await navigator.share({
                       title: `Bilty ${bilty.biltyNo}`,
                       text: `Al Naeem Car Carriers Service - Bilty ${bilty.biltyNo}`,
                       files: [file],
                     });
                   } else {
                     const url = window.URL.createObjectURL(blob);
                     const a = document.createElement("a");
                     a.href = url;
                     a.download = `Bilty-${bilty.biltyNo}.pdf`;
                     document.body.appendChild(a);
                     a.click();
                     document.body.removeChild(a);
                     window.URL.revokeObjectURL(url);
                   }
                 } catch {
                   // User cancelled or sharing failed
                 }
               }}
               className="flex-1 border rounded-lg px-4 py-3 text-sm hover:bg-gray-50"
             >
               Share PDF
             </button>
           </div>

           {/* Communication */}

           <div className="mt-4">
             <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">Send Document</p>
             <div className="flex flex-wrap gap-2">
               <SendBiltyButton
                 bilty={bilty}
                 recipientLabel="Consignor"
                 recipientName={bilty.consignorParty?.partyName || bilty.consignorName}
                 phone={bilty.consignorPhone}
               />
               <SendBiltyButton
                 bilty={bilty}
                 recipientLabel="Consignee"
                 recipientName={bilty.consigneeParty?.partyName || bilty.consigneeName}
                 phone={bilty.consigneePhone}
               />
               <SendBiltyButton
                 bilty={bilty}
                 recipientLabel="Clearing Agent"
                 recipientName={bilty.clearingAgentParty?.partyName || bilty.clearingAgentName || undefined}
                 phone={bilty.clearingAgentParty?.whatsapp || bilty.clearingAgentParty?.phone || null}
               />
             </div>
            </div>
          </div>
       </div>
     </main>
   );
 }

 type SendBiltyButtonProps = {
   bilty: Bilty | null;
   recipientLabel: string;
   recipientName: string | undefined;
   phone: string | null | undefined;
 };

 function SendBiltyButton({ bilty, recipientLabel, recipientName, phone }: SendBiltyButtonProps) {
   const [sending, setSending] = useState(false);

   if (!bilty) return null;

   const handleClick = async () => {
     try {
       setSending(true);
       const response = await fetch(`/api/bilty/${bilty.id}/pdf`);
       if (!response.ok) {
         const data = await response.json().catch(() => ({}));
         alert(data.message || "Unable to generate PDF");
         return;
       }

       const blob = await response.blob();
       const file = new File([blob], `Bilty-${bilty.biltyNo}.pdf`, { type: "application/pdf" });
       const title = recipientName ? `Send Bilty ${bilty.biltyNo} to ${recipientName}` : `Bilty ${bilty.biltyNo}`;
       const text = getBiltyShareMessage({
         biltyNo: bilty.biltyNo,
         from: bilty.fromLocation.name,
         to: bilty.toLocation.name,
       });

       if (navigator.canShare && navigator.canShare({ files: [file] })) {
         await navigator.share({
           title,
           text,
           files: [file],
         });
         return;
       }

       const url = window.URL.createObjectURL(blob);
       const a = document.createElement("a");
       a.href = url;
       a.download = `Bilty-${bilty.biltyNo}.pdf`;
       document.body.appendChild(a);
       a.click();
       document.body.removeChild(a);
       window.URL.revokeObjectURL(url);

       const normalizedPhone = normalizePhone(phone);
       if (normalizedPhone) {
         const encodedText = encodeURIComponent(text);
         const whatsappUrl = `https://wa.me/${normalizedPhone}?text=${encodedText}`;
         window.open(whatsappUrl, "_blank");
       }
     } catch {
       // User cancelled or sharing failed
     } finally {
       setSending(false);
     }
   };

   return (
     <button
       type="button"
       onClick={handleClick}
       disabled={sending}
       className="border rounded-lg px-3 py-2 text-xs sm:text-sm hover:bg-gray-50 disabled:opacity-50"
     >
       {sending ? "Preparing..." : `Send to ${recipientLabel}`}
     </button>
   );
 }
