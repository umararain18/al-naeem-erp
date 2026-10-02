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

  const [updating, setUpdating] = useState(false);

  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [editingLocation, setEditingLocation] = useState<Location | null>(null);

  const [error, setError] = useState("");

  const [message, setMessage] = useState("");

  const [search, setSearch] = useState("");

  const [name, setName] = useState("");

  function resetForm() {
    setName("");
  }

  function startEditingLocation(location: Location) {
    setEditingLocation(location);
    setName(location.name);
    setError("");
    setMessage("");
  }

  function cancelEdit() {
    setEditingLocation(null);
    resetForm();
    setError("");
    setMessage("");
  }

  async function loadLocations() {
    try {
      setError("");

      const response = await fetch("/api/locations?includeInactive=1");

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

  async function handleUpdateLocation(event: FormEvent) {
    event.preventDefault();

    if (!editingLocation) {
      return;
    }

    setError("");
    setMessage("");

    const trimmedName = name.trim();

    if (trimmedName.length < 2) {
      setError("Location name must be at least 2 characters");
      return;
    }

    setUpdating(true);

    try {
      const response = await fetch(`/api/locations/${editingLocation.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: trimmedName,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || "Unable to update location");
        return;
      }

      setMessage("Location updated successfully.");

      setEditingLocation(null);
      resetForm();

      await loadLocations();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setUpdating(false);
    }
  }

  async function toggleActive(location: Location) {
    const action = location.isActive ? "deactivate" : "activate";

    const confirmed = window.confirm(`Are you sure you want to ${action} "${location.name}"?`);

    if (!confirmed) {
      return;
    }

    setActionLoading(location.id);
    setError("");
    setMessage("");

    try {
      const response = await fetch(`/api/locations/${location.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          isActive: !location.isActive,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || `Unable to ${action} location`);
        return;
      }

      setMessage(`Location ${action}d successfully.`);

      await loadLocations();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setActionLoading(null);
    }
  }

  async function deleteLocation(location: Location) {
    const confirmed = window.confirm(
      `Are you sure you want to permanently delete "${location.name}"?\n\nThis should only be used if the location has no Bilty history.`
    );

    if (!confirmed) {
      return;
    }

    setActionLoading(location.id);
    setError("");
    setMessage("");

    try {
      const response = await fetch(`/api/locations/${location.id}`, {
        method: "DELETE",
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || "Unable to delete location");
        return;
      }

      setMessage("Location deleted successfully.");

      await loadLocations();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setActionLoading(null);
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
            <h2 className="text-xl font-semibold mb-5">
              {editingLocation ? "Edit Location" : "Add Location"}
            </h2>

            <form onSubmit={editingLocation ? handleUpdateLocation : handleCreateLocation} className="space-y-4">
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
                disabled={editingLocation ? updating : creating}
                className="w-full bg-black text-white py-3 rounded-lg disabled:opacity-50"
              >
                {editingLocation
                  ? updating
                    ? "Updating..."
                    : "Update Location"
                  : creating
                    ? "Creating..."
                    : "Create Location"}
              </button>

              {editingLocation && (
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="w-full border rounded-lg py-3 hover:bg-gray-50"
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
                      <th className="py-3 pr-4">Actions</th>
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

                        <td className="py-3 pr-4">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => startEditingLocation(location)}
                              className="border rounded-lg px-3 py-1 text-sm hover:bg-gray-50"
                            >
                              Edit
                            </button>

                            <button
                              type="button"
                              disabled={actionLoading === location.id}
                              onClick={() => toggleActive(location)}
                              className="border rounded-lg px-3 py-1 text-sm hover:bg-gray-50 disabled:opacity-50"
                            >
                              {location.isActive ? "Deactivate" : "Activate"}
                            </button>

                            <button
                              type="button"
                              disabled={actionLoading === location.id}
                              onClick={() => deleteLocation(location)}
                              className="border border-red-300 text-red-600 rounded-lg px-3 py-1 text-sm hover:bg-red-50 disabled:opacity-50"
                            >
                              Delete
                            </button>
                          </div>
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
