"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Contact = {
  id: string;
  phone: string;
  name: string;
  roles: string[];
  aliases: string[];
  city: string | null;
  route: string | null;
  firstDate: string;
  lastDate: string;
  biltyCount: number;
  revenue: number;
  lastVehicle: string | null;
  linkedParty: { id: string; partyName: string } | null;
  isBroker: boolean;
  brokerReason: string | null;
  optedOut: boolean;
  optOutReason: string | null;
  mergedFrom: { id: string; phone: string; name: string }[];
  mergedInto: { id: string; phone: string; name: string } | null;
};

type BiltyRow = { id: string; biltyNo: string; date: string; total: number; route: string };
type BillRow = { id: string; billNo: string; date: string; total: number };

function formatCurrency(value: number) {
  return `Rs. ${Math.round(value).toLocaleString()}`;
}

export default function MarketingContactDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const [contact, setContact] = useState<Contact | null>(null);
  const [bilties, setBilties] = useState<BiltyRow[]>([]);
  const [bills, setBills] = useState<BillRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    try {
      const { id } = await params;
      const res = await fetch(`/api/marketing/contacts/${id}`);
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.message || "Unable to load contact");
        return;
      }
      setContact(json.contact);
      setBilties(json.bilties);
      setBills(json.bills);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  async function handleUnmerge(id: string) {
    const res = await fetch(`/api/marketing/contacts/${id}/unmerge`, { method: "POST" });
    const json = await res.json();
    if (res.ok && json.success) load();
  }

  if (loading) return <main className="min-h-screen bg-gray-50 p-6"><p className="text-gray-500">Loading...</p></main>;
  if (error || !contact) return <main className="min-h-screen bg-gray-50 p-6"><p className="text-red-600">{error || "Contact not found"}</p></main>;

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto p-6">
        <div className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{contact.name}</h1>
            <p className="text-gray-600">{contact.phone}</p>
          </div>
          <Link href="/marketing/contacts" className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50">Back to Contacts</Link>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div><p className="text-gray-500">Roles</p><p className="font-medium">{contact.roles.join(", ") || "—"}</p></div>
            <div><p className="text-gray-500">City / Route</p><p className="font-medium">{contact.city || "—"} {contact.route ? `(${contact.route})` : ""}</p></div>
            <div><p className="text-gray-500">Last Vehicle</p><p className="font-medium">{contact.lastVehicle || "—"}</p></div>
            <div><p className="text-gray-500">Bilty Count</p><p className="font-medium">{contact.biltyCount}</p></div>
            <div><p className="text-gray-500">Revenue</p><p className="font-medium">{formatCurrency(contact.revenue)}</p></div>
            <div><p className="text-gray-500">First / Last Date</p><p className="font-medium">{new Date(contact.firstDate).toLocaleDateString()} – {new Date(contact.lastDate).toLocaleDateString()}</p></div>
            {contact.linkedParty && (
              <div><p className="text-gray-500">Linked Party</p><Link href={`/parties/${contact.linkedParty.id}`} className="text-blue-600 hover:underline font-medium">{contact.linkedParty.partyName}</Link></div>
            )}
            {contact.isBroker && (
              <div><p className="text-gray-500">Broker</p><p className="font-medium text-purple-700">Yes ({contact.brokerReason})</p></div>
            )}
            {contact.optedOut && (
              <div><p className="text-gray-500">Opted Out</p><p className="font-medium text-red-700">{contact.optOutReason || "Yes"}</p></div>
            )}
          </div>

          {contact.aliases.length > 0 && (
            <div className="mt-4 pt-4 border-t">
              <p className="text-gray-500 text-sm mb-1">Other names seen</p>
              <p className="text-sm">{contact.aliases.join(", ")}</p>
            </div>
          )}

          {contact.mergedInto && (
            <div className="mt-4 pt-4 border-t text-sm">
              <p>Merged into <Link href={`/marketing/contacts/${contact.mergedInto.id}`} className="text-blue-600 hover:underline">{contact.mergedInto.name} ({contact.mergedInto.phone})</Link>.</p>
            </div>
          )}

          {contact.mergedFrom.length > 0 && (
            <div className="mt-4 pt-4 border-t text-sm">
              <p className="text-gray-500 mb-1">Merged contacts:</p>
              {contact.mergedFrom.map((m) => (
                <div key={m.id} className="flex items-center justify-between py-1">
                  <span>{m.name} ({m.phone})</span>
                  <button type="button" onClick={() => handleUnmerge(m.id)} className="text-xs text-blue-600 hover:underline">Unmerge</button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4">Bilty History ({bilties.length})</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                <tr><th className="px-4 py-2">Bilty No</th><th className="px-4 py-2">Date</th><th className="px-4 py-2">Route</th><th className="px-4 py-2 text-right">Total</th></tr>
              </thead>
              <tbody className="divide-y">
                {bilties.map((b) => (
                  <tr key={b.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2"><Link href={`/bilty/${b.id}`} className="text-blue-600 hover:underline">{b.biltyNo}</Link></td>
                    <td className="px-4 py-2">{new Date(b.date).toLocaleDateString()}</td>
                    <td className="px-4 py-2">{b.route}</td>
                    <td className="px-4 py-2 text-right">{formatCurrency(b.total)}</td>
                  </tr>
                ))}
                {bilties.length === 0 && <tr><td colSpan={4} className="px-4 py-4 text-center text-gray-500">No Bilty history</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {bills.length > 0 && (
          <div className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-lg font-semibold mb-4">Bill History ({bills.length})</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
                  <tr><th className="px-4 py-2">Bill No</th><th className="px-4 py-2">Date</th><th className="px-4 py-2 text-right">Total</th></tr>
                </thead>
                <tbody className="divide-y">
                  {bills.map((b) => (
                    <tr key={b.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2"><Link href={`/bill/${b.id}`} className="text-blue-600 hover:underline">{b.billNo}</Link></td>
                      <td className="px-4 py-2">{new Date(b.date).toLocaleDateString()}</td>
                      <td className="px-4 py-2 text-right">{formatCurrency(b.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
