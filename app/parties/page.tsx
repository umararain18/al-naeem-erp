"use client";

import { FormEvent, useEffect, useState } from "react";

type PartyType =
  | "TRANSPORTER"
  | "CLEARING_AGENT"
  | "CUSTOMER"
  | "VENDOR";

type Party = {
  id: string;
  partyName: string;
  contactPerson: string | null;
  phone: string | null;
  whatsapp: string | null;
  cnicNtn: string | null;
  address: string | null;
  partyTypes: PartyType[];
  openingBalance: string;
  openingBalanceType: "DEBIT" | "CREDIT" | null;
  isActive: boolean;
  notes: string | null;
};

const partyTypeOptions: {
  value: PartyType;
  label: string;
}[] = [
  { value: "TRANSPORTER", label: "Transporter" },
  {
    value: "CLEARING_AGENT",
    label: "Clearing Agent / Delivery Point",
  },
  { value: "CUSTOMER", label: "Customer" },
  { value: "VENDOR", label: "Vendor" },
];

export default function PartiesPage() {
  const [parties, setParties] = useState<Party[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [partyName, setPartyName] = useState("");
  const [contactPerson, setContactPerson] = useState("");
  const [phone, setPhone] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [cnicNtn, setCnicNtn] = useState("");
  const [address, setAddress] = useState("");

  const [partyTypes, setPartyTypes] = useState<PartyType[]>([
    "CUSTOMER",
  ]);

  const [openingBalance, setOpeningBalance] = useState("");
  const [openingBalanceType, setOpeningBalanceType] =
    useState<"DEBIT" | "CREDIT">("DEBIT");

  function togglePartyType(type: PartyType) {
    setPartyTypes((current) => {
      if (current.includes(type)) {
        return current.filter((item) => item !== type);
      }

      return [...current, type];
    });
  }

  async function loadParties() {
    try {
      setError("");

      const response = await fetch("/api/parties");
      const data = await response.json();

      if (!response.ok) {
        setError(data.message || "Unable to load parties");
        return;
      }

      setParties(data.parties);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadParties();
  }, []);

  async function handleCreateParty(event: FormEvent) {
    event.preventDefault();

    setError("");
    setMessage("");

    if (partyTypes.length === 0) {
      setError("Please select at least one party type.");
      return;
    }

    setCreating(true);

    try {
      const response = await fetch("/api/parties", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          partyName,
          contactPerson,
          phone,
          whatsapp,
          cnicNtn,
          address,
          partyTypes,
          openingBalance: openingBalance
            ? Number(openingBalance)
            : 0,
          openingBalanceType: openingBalance
            ? openingBalanceType
            : undefined,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || "Unable to create party");
        return;
      }

      setMessage("Party created successfully.");

      setPartyName("");
      setContactPerson("");
      setPhone("");
      setWhatsapp("");
      setCnicNtn("");
      setAddress("");
      setPartyTypes(["CUSTOMER"]);
      setOpeningBalance("");
      setOpeningBalanceType("DEBIT");

      await loadParties();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setCreating(false);
    }
  }

  function formatPartyTypes(types: PartyType[]) {
    return types
      .map(
        (type) =>
          partyTypeOptions.find(
            (option) => option.value === type
          )?.label || type
      )
      .join(", ");
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Party Master</h1>

          <p className="text-gray-600">
            Manage customers, vendors, transporters and
            delivery points.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Add Party */}
          <section className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-xl font-semibold mb-5">
              Add Party
            </h2>

            <form
              onSubmit={handleCreateParty}
              className="space-y-4"
            >
              <input
                type="text"
                placeholder="Party Name"
                value={partyName}
                onChange={(e) =>
                  setPartyName(e.target.value)
                }
                className="w-full border rounded-lg px-4 py-3"
                required
              />

              <input
                type="text"
                placeholder="Contact Person"
                value={contactPerson}
                onChange={(e) =>
                  setContactPerson(e.target.value)
                }
                className="w-full border rounded-lg px-4 py-3"
              />

              <input
                type="text"
                placeholder="Phone"
                value={phone}
                onChange={(e) =>
                  setPhone(e.target.value)
                }
                className="w-full border rounded-lg px-4 py-3"
              />

              <input
                type="text"
                placeholder="WhatsApp"
                value={whatsapp}
                onChange={(e) =>
                  setWhatsapp(e.target.value)
                }
                className="w-full border rounded-lg px-4 py-3"
              />

              <input
                type="text"
                placeholder="CNIC / NTN"
                value={cnicNtn}
                onChange={(e) =>
                  setCnicNtn(e.target.value)
                }
                className="w-full border rounded-lg px-4 py-3"
              />

              <textarea
                placeholder="Address"
                value={address}
                onChange={(e) =>
                  setAddress(e.target.value)
                }
                rows={3}
                className="w-full border rounded-lg px-4 py-3"
              />

              {/* Party Types */}
              <div>
                <p className="text-sm font-medium mb-2">
                  Party Type
                </p>

                <div className="space-y-2">
                  {partyTypeOptions.map((option) => (
                    <label
                      key={option.value}
                      className="flex items-center gap-3 border rounded-lg px-3 py-2 cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={partyTypes.includes(
                          option.value
                        )}
                        onChange={() =>
                          togglePartyType(option.value)
                        }
                      />

                      <span className="text-sm">
                        {option.label}
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <input
                type="number"
                min="0"
                placeholder="Opening Balance"
                value={openingBalance}
                onChange={(e) =>
                  setOpeningBalance(e.target.value)
                }
                className="w-full border rounded-lg px-4 py-3"
              />

              <select
                value={openingBalanceType}
                onChange={(e) =>
                  setOpeningBalanceType(
                    e.target.value as "DEBIT" | "CREDIT"
                  )
                }
                className="w-full border rounded-lg px-4 py-3 bg-white"
              >
                <option value="DEBIT">Debit</option>
                <option value="CREDIT">Credit</option>
              </select>

              {error && (
                <p className="text-sm text-red-600">
                  {error}
                </p>
              )}

              {message && (
                <p className="text-sm text-green-600">
                  {message}
                </p>
              )}

              <button
                type="submit"
                disabled={creating}
                className="w-full bg-black text-white py-3 rounded-lg disabled:opacity-50"
              >
                {creating
                  ? "Creating..."
                  : "Create Party"}
              </button>
            </form>
          </section>

          {/* Party List */}
          <section className="lg:col-span-2 bg-white rounded-xl shadow-sm p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-xl font-semibold">
                  All Parties
                </h2>

                <p className="text-sm text-gray-500">
                  {parties.length}{" "}
                  {parties.length === 1
                    ? "party"
                    : "parties"}
                </p>
              </div>

              <button
                onClick={loadParties}
                className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
              >
                Refresh
              </button>
            </div>

            {loading ? (
              <p className="text-gray-500">
                Loading parties...
              </p>
            ) : parties.length === 0 ? (
              <p className="text-gray-500">
                No parties found.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-3 pr-4">
                        Party
                      </th>

                      <th className="py-3 pr-4">
                        Phone
                      </th>

                      <th className="py-3 pr-4">
                        Type
                      </th>

                      <th className="py-3 pr-4">
                        Opening
                      </th>

                      <th className="py-3 pr-4">
                        Status
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {parties.map((party) => (
                      <tr
                        key={party.id}
                        className="border-b"
                      >
                        <td className="py-3 pr-4">
                          <div className="font-medium">
                            {party.partyName}
                          </div>

                          {party.address && (
                            <div className="text-xs text-gray-500 mt-1">
                              {party.address}
                            </div>
                          )}
                        </td>

                        <td className="py-3 pr-4">
                          {party.phone || "-"}
                        </td>

                        <td className="py-3 pr-4">
                          {formatPartyTypes(
                            party.partyTypes
                          )}
                        </td>

                        <td className="py-3 pr-4">
                          Rs.{" "}
                          {Number(
                            party.openingBalance
                          ).toLocaleString()}
                        </td>

                        <td className="py-3 pr-4">
                          {party.isActive
                            ? "Active"
                            : "Inactive"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      </div>
    </main>
  );
}