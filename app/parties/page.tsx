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
  {
    value: "TRANSPORTER",
    label: "Transporter",
  },
  {
    value: "CLEARING_AGENT",
    label: "Clearing Agent / Delivery Point",
  },
  {
    value: "CUSTOMER",
    label: "Customer",
  },
  {
    value: "VENDOR",
    label: "Vendor",
  },
];

export default function PartiesPage() {
  const [parties, setParties] =
    useState<Party[]>([]);

  const [loading, setLoading] =
    useState(true);

  const [creating, setCreating] =
    useState(false);

  const [updating, setUpdating] =
    useState(false);

  const [actionLoading, setActionLoading] =
    useState<string | null>(null);

  const [editingParty, setEditingParty] =
    useState<Party | null>(null);

  const [error, setError] =
    useState("");

  const [message, setMessage] =
    useState("");

  const [search, setSearch] =
    useState("");

  const [partyName, setPartyName] =
    useState("");

  const [contactPerson, setContactPerson] =
    useState("");

  const [phone, setPhone] =
    useState("");

  const [whatsapp, setWhatsapp] =
    useState("");

  const [cnicNtn, setCnicNtn] =
    useState("");

  const [address, setAddress] =
    useState("");

  const [partyTypes, setPartyTypes] =
    useState<PartyType[]>(["CUSTOMER"]);

  const [openingBalance, setOpeningBalance] =
    useState("");

  const [openingBalanceType, setOpeningBalanceType] =
    useState<"DEBIT" | "CREDIT">("DEBIT");

  function togglePartyType(type: PartyType) {
    setPartyTypes((current) => {
      if (current.includes(type)) {
        return current.filter(
          (item) => item !== type
        );
      }

      return [...current, type];
    });
  }

  function resetForm() {
    setPartyName("");
    setContactPerson("");
    setPhone("");
    setWhatsapp("");
    setCnicNtn("");
    setAddress("");
    setPartyTypes(["CUSTOMER"]);
    setOpeningBalance("");
    setOpeningBalanceType("DEBIT");
  }

  async function loadParties() {
    try {
      setError("");

      const response = await fetch(
        "/api/parties"
      );

      const data = await response.json();

      if (!response.ok) {
        setError(
          data.message ||
            "Unable to load parties"
        );
        return;
      }

      setParties(data.parties);
    } catch {
      setError(
        "Unable to connect to the server"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadParties();
  }, []);

  async function handleCreateParty(
    event: FormEvent
  ) {
    event.preventDefault();

    setError("");
    setMessage("");

    if (partyTypes.length === 0) {
      setError(
        "Please select at least one party type."
      );
      return;
    }

    setCreating(true);

    try {
      const response = await fetch(
        "/api/parties",
        {
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
            openingBalanceType:
              openingBalance
                ? openingBalanceType
                : undefined,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        setError(
          data.message ||
            "Unable to create party"
        );
        return;
      }

      setMessage(
        "Party created successfully."
      );

      resetForm();

      await loadParties();
    } catch {
      setError(
        "Unable to connect to the server"
      );
    } finally {
      setCreating(false);
    }
  }

  function startEditingParty(
    party: Party
  ) {
    setEditingParty(party);

    setPartyName(party.partyName);
    setContactPerson(
      party.contactPerson || ""
    );
    setPhone(party.phone || "");
    setWhatsapp(party.whatsapp || "");
    setCnicNtn(party.cnicNtn || "");
    setAddress(party.address || "");
    setPartyTypes(party.partyTypes);

    setOpeningBalance(
      String(party.openingBalance)
    );

    setOpeningBalanceType(
      party.openingBalanceType ||
        "DEBIT"
    );

    setError("");
    setMessage("");

    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
  }

  async function handleUpdateParty(
    event: FormEvent
  ) {
    event.preventDefault();

    if (!editingParty) {
      return;
    }

    setError("");
    setMessage("");

    if (partyTypes.length === 0) {
      setError(
        "Please select at least one party type."
      );
      return;
    }

    setUpdating(true);

    try {
      const response = await fetch(
        `/api/parties/${editingParty.id}`,
        {
          method: "PATCH",
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
            openingBalanceType:
              openingBalance
                ? openingBalanceType
                : null,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        setError(
          data.message ||
            "Unable to update party"
        );
        return;
      }

      setMessage(
        "Party updated successfully."
      );

      setEditingParty(null);

      resetForm();

      await loadParties();
    } catch {
      setError(
        "Unable to connect to the server"
      );
    } finally {
      setUpdating(false);
    }
  }

  function cancelEdit() {
    setEditingParty(null);
    resetForm();
    setError("");
    setMessage("");
  }

  async function toggleActive(
    party: Party
  ) {
    const action = party.isActive
      ? "deactivate"
      : "activate";

    const confirmed = window.confirm(
      `Are you sure you want to ${action} "${party.partyName}"?`
    );

    if (!confirmed) {
      return;
    }

    setActionLoading(party.id);
    setError("");
    setMessage("");

    try {
      const response = await fetch(
        `/api/parties/${party.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type":
              "application/json",
          },
          body: JSON.stringify({
            isActive: !party.isActive,
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        setError(
          data.message ||
            `Unable to ${action} party`
        );
        return;
      }

      setMessage(
        `Party ${action}d successfully.`
      );

      await loadParties();
    } catch {
      setError(
        "Unable to connect to the server"
      );
    } finally {
      setActionLoading(null);
    }
  }

  async function deleteParty(
    party: Party
  ) {
    const confirmed = window.confirm(
      `Are you sure you want to permanently delete "${party.partyName}"?\n\nThis should only be used if the party has no accounting history.`
    );

    if (!confirmed) {
      return;
    }

    setActionLoading(party.id);
    setError("");
    setMessage("");

    try {
      const response = await fetch(
        `/api/parties/${party.id}`,
        {
          method: "DELETE",
        }
      );

      const data = await response.json();

      if (!response.ok) {
        setError(
          data.message ||
            "Unable to delete party"
        );
        return;
      }

      setMessage(
        "Party deleted successfully."
      );

      await loadParties();
    } catch {
      setError(
        "Unable to connect to the server"
      );
    } finally {
      setActionLoading(null);
    }
  }

  function openLedger(party: Party) {
    alert(
      `Ledger for "${party.partyName}" will be connected after the Accounts/Ledger module is completed.`
    );
  }

  function formatPartyTypes(
    types: PartyType[]
  ) {
    return types
      .map(
        (type) =>
          partyTypeOptions.find(
            (option) =>
              option.value === type
          )?.label || type
      )
      .join(", ");
  }

  const filteredParties =
    parties.filter((party) => {
      const searchText =
        search.toLowerCase().trim();

      if (!searchText) {
        return true;
      }

      return (
        party.partyName
          .toLowerCase()
          .includes(searchText) ||
        (party.contactPerson || "")
          .toLowerCase()
          .includes(searchText) ||
        (party.phone || "")
          .toLowerCase()
          .includes(searchText) ||
        (party.address || "")
          .toLowerCase()
          .includes(searchText) ||
        formatPartyTypes(
          party.partyTypes
        )
          .toLowerCase()
          .includes(searchText)
      );
    });

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-6">

        <div className="mb-6">
          <h1 className="text-2xl font-bold">
            Party Master
          </h1>

          <p className="text-gray-600">
            Manage customers, vendors,
            transporters and delivery points.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* FORM */}

          <section className="bg-white rounded-xl shadow-sm p-6">

            <h2 className="text-xl font-semibold mb-5">
              {editingParty
                ? "Edit Party"
                : "Add Party"}
            </h2>

            <form
              onSubmit={
                editingParty
                  ? handleUpdateParty
                  : handleCreateParty
              }
              className="space-y-4"
            >

              <input
                type="text"
                placeholder="Party Name"
                value={partyName}
                onChange={(e) =>
                  setPartyName(
                    e.target.value
                  )
                }
                className="w-full border rounded-lg px-4 py-3"
                required
              />

              <input
                type="text"
                placeholder="Contact Person"
                value={contactPerson}
                onChange={(e) =>
                  setContactPerson(
                    e.target.value
                  )
                }
                className="w-full border rounded-lg px-4 py-3"
              />

              <input
                type="text"
                placeholder="Phone"
                value={phone}
                onChange={(e) =>
                  setPhone(
                    e.target.value
                  )
                }
                className="w-full border rounded-lg px-4 py-3"
              />

              <input
                type="text"
                placeholder="WhatsApp"
                value={whatsapp}
                onChange={(e) =>
                  setWhatsapp(
                    e.target.value
                  )
                }
                className="w-full border rounded-lg px-4 py-3"
              />

              <input
                type="text"
                placeholder="CNIC / NTN"
                value={cnicNtn}
                onChange={(e) =>
                  setCnicNtn(
                    e.target.value
                  )
                }
                className="w-full border rounded-lg px-4 py-3"
              />

              <textarea
                placeholder="Address"
                value={address}
                onChange={(e) =>
                  setAddress(
                    e.target.value
                  )
                }
                rows={3}
                className="w-full border rounded-lg px-4 py-3"
              />

              <div>
                <p className="text-sm font-medium mb-2">
                  Party Type
                </p>

                <div className="space-y-2">

                  {partyTypeOptions.map(
                    (option) => (
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
                            togglePartyType(
                              option.value
                            )
                          }
                        />

                        <span className="text-sm">
                          {option.label}
                        </span>
                      </label>
                    )
                  )}

                </div>
              </div>

              <input
                type="number"
                min="0"
                placeholder="Opening Balance"
                value={openingBalance}
                onChange={(e) =>
                  setOpeningBalance(
                    e.target.value
                  )
                }
                className="w-full border rounded-lg px-4 py-3"
              />

              <select
                value={openingBalanceType}
                onChange={(e) =>
                  setOpeningBalanceType(
                    e.target.value as
                      | "DEBIT"
                      | "CREDIT"
                  )
                }
                className="w-full border rounded-lg px-4 py-3 bg-white"
              >
                <option value="DEBIT">
                  Debit
                </option>
                <option value="CREDIT">
                  Credit
                </option>
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
                disabled={
                  creating ||
                  updating
                }
                className="w-full bg-black text-white py-3 rounded-lg disabled:opacity-50"
              >
                {editingParty
                  ? updating
                    ? "Updating..."
                    : "Update Party"
                  : creating
                    ? "Creating..."
                    : "Create Party"}
              </button>

              {editingParty && (
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="w-full border py-3 rounded-lg hover:bg-gray-50"
                >
                  Cancel Edit
                </button>
              )}

            </form>
          </section>

          {/* LIST */}

          <section className="lg:col-span-2 bg-white rounded-xl shadow-sm p-6">

            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">

              <div>
                <h2 className="text-xl font-semibold">
                  All Parties
                </h2>

                <p className="text-sm text-gray-500">
                  {filteredParties.length}{" "}
                  {filteredParties.length === 1
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

            <div className="mb-5">

              <input
                type="text"
                placeholder="Search party, contact, phone, address or type..."
                value={search}
                onChange={(e) =>
                  setSearch(
                    e.target.value
                  )
                }
                className="w-full border rounded-lg px-4 py-3"
              />

            </div>

            {loading ? (

              <p className="text-gray-500">
                Loading parties...
              </p>

            ) : filteredParties.length === 0 ? (

              <p className="text-gray-500">
                {search
                  ? "No matching parties found."
                  : "No parties found."}
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

                      <th className="py-3 pr-4">
                        Actions
                      </th>

                    </tr>
                  </thead>

                  <tbody>

                    {filteredParties.map(
                      (party) => (

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

                            {party.openingBalanceType && (
                              <span className="text-xs text-gray-500 ml-1">
                                (
                                {
                                  party.openingBalanceType
                                }
                                )
                              </span>
                            )}
                          </td>

                          <td className="py-3 pr-4">

                            <span
                              className={
                                party.isActive
                                  ? "text-green-600"
                                  : "text-red-600"
                              }
                            >
                              {party.isActive
                                ? "Active"
                                : "Inactive"}
                            </span>

                          </td>

                          <td className="py-3 pr-4">

                            <div className="flex flex-wrap gap-2">

                              <button
                                type="button"
                                onClick={() =>
                                  startEditingParty(
                                    party
                                  )
                                }
                                className="border rounded-lg px-3 py-1 text-sm hover:bg-gray-50"
                              >
                                Edit
                              </button>

                              <button
                                type="button"
                                disabled={
                                  actionLoading ===
                                  party.id
                                }
                                onClick={() =>
                                  toggleActive(
                                    party
                                  )
                                }
                                className="border rounded-lg px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
                              >
                                {party.isActive
                                  ? "Deactivate"
                                  : "Activate"}
                              </button>

                              <button
                                type="button"
                                disabled={
                                  actionLoading ===
                                  party.id
                                }
                                onClick={() =>
                                  deleteParty(
                                    party
                                  )
                                }
                                className="border border-red-300 text-red-600 rounded-lg px-3 py-1 text-sm hover:bg-red-50 disabled:opacity-50"
                              >
                                Delete
                              </button>

                              <button
                                type="button"
                                onClick={() =>
                                  openLedger(
                                    party
                                  )
                                }
                                className="border rounded-lg px-3 py-1 text-sm hover:bg-gray-50"
                              >
                                Ledger
                              </button>

                            </div>

                          </td>

                        </tr>

                      )
                    )}

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