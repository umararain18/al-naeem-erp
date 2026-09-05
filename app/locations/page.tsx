"use client";

import { FormEvent, useEffect, useState } from "react";

type Location = {
  id: string;
  name: string;
  isActive: boolean;
};

export default function LocationsPage() {
  const [locations, setLocations] = useState<Location[]>([]);

  const [loading, setLoading] = useState(true);

  const [creating, setCreating] = useState(false);

  const [error, setError] = useState("");

  const [message, setMessage] = useState("");

  const [search, setSearch] = useState("");

  const [name, setName] = useState("");

  function resetForm() {
    setName("");
  }

  async function loadLocations() {
    try {
      setError("");

      const response = await fetch("/api/locations");

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || "Unable to load locations");
        return;
      }

      setLocations(data.locations || []);
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadLocations();
  }, []);

  async function handleCreateLocation(event: FormEvent) {
    event.preventDefault();

    setError("");
    setMessage("");

    const trimmedName = name.trim();

    if (trimmedName.length < 2) {
      setError("Location name must be at least 2 characters");
      return;
    }

    setCreating(true);

    try {
      const response = await fetch("/api/locations", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: trimmedName,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || "Unable to create location");
        return;
      }

      setMessage("Location created successfully.");

      resetForm();

      await loadLocations();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setCreating(false);
    }
  }

  const filteredLocations = locations.filter((location) => {
    const searchText = search.toLowerCase().trim();

    if (!searchText) {
      return true;
    }

    return location.name.toLowerCase().includes(searchText);
  });

  return (
    <main className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto p-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">Location Master</h1>
          <p className="text-gray-600">Manage cities, branches, and delivery points.</p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* FORM */}

          <section className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-xl font-semibold mb-5">Add Location</h2>

            <form onSubmit={handleCreateLocation} className="space-y-4">
              <input
                type="text"
                placeholder="Location Name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full border rounded-lg px-4 py-3"
                required
              />

              {error && (
                <p className="text-sm text-red-600">{error}</p>
              )}

              {message && (
                <p className="text-sm text-green-600">{message}</p>
              )}

              <button
                type="submit"
                disabled={creating}
                className="w-full bg-black text-white py-3 rounded-lg disabled:opacity-50"
              >
                {creating ? "Creating..." : "Create Location"}
              </button>
            </form>
          </section>

          {/* LIST */}

          <section className="lg:col-span-2 bg-white rounded-xl shadow-sm p-6">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-5">
              <div>
                <h2 className="text-xl font-semibold">All Locations</h2>
                <p className="text-sm text-gray-500">
                  {filteredLocations.length} {filteredLocations.length === 1 ? "location" : "locations"}
                </p>
              </div>

              <button
                onClick={loadLocations}
                className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
              >
                Refresh
              </button>
            </div>

            <div className="mb-5">
              <input
                type="text"
                placeholder="Search location..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full border rounded-lg px-4 py-3"
              />
            </div>

            {loading ? (
              <p className="text-gray-500">Loading locations...</p>
            ) : filteredLocations.length === 0 ? (
              <p className="text-gray-500">
                {search ? "No matching locations found." : "No locations found."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-3 pr-4">Location</th>
                      <th className="py-3 pr-4">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredLocations.map((location) => (
                      <tr key={location.id} className="border-b">
                        <td className="py-3 pr-4">
                          <div className="font-medium">{location.name}</div>
                        </td>

                        <td className="py-3 pr-4">
                          <span className={location.isActive ? "text-green-600" : "text-red-600"}>
                            {location.isActive ? "Active" : "Inactive"}
                          </span>
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
