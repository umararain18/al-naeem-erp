"use client";

import { FormEvent, useEffect, useState } from "react";

type User = {
  id: string;
  fullName: string;
  username: string;
  phone: string | null;
  role: "SUPER_ADMIN" | "MANAGER" | "VIEWER";
  isActive: boolean;
  lastLogin?: string | null;
  createdAt: string;
};

type EditForm = {
  fullName: string;
  username: string;
  password: string;
  phone: string;
  role: User["role"];
};

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<User["role"]>("VIEWER");

  const [editingUser, setEditingUser] = useState<User | null>(null);

  const [editForm, setEditForm] = useState<EditForm>({
    fullName: "",
    username: "",
    password: "",
    phone: "",
    role: "VIEWER",
  });

  async function loadUsers() {
  try {
    setError("");

    const response = await fetch("/api/users");

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Unable to load users");
      }

      setUsers(data.users || []);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Unable to connect to the server"
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function fetchUsers() {
      try {
        const response = await fetch("/api/users");

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || "Unable to load users");
        }

        if (!cancelled) {
          setUsers(data.users || []);
          setError("");
        }
      } catch (error) {
        if (!cancelled) {
          setError(
            error instanceof Error
              ? error.message
              : "Unable to connect to the server"
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchUsers();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreateUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setError("");
    setMessage("");
    setCreating(true);

    try {
      const response = await fetch("/api/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          fullName,
          username,
          password,
          phone,
          role,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || "Unable to create user");
        return;
      }

      setMessage("User created successfully.");

      setFullName("");
      setUsername("");
      setPassword("");
      setPhone("");
      setRole("VIEWER");

      await loadUsers();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setCreating(false);
    }
  }

  function openEditUser(user: User) {
    setError("");
    setMessage("");

    setEditingUser(user);

    setEditForm({
      fullName: user.fullName,
      username: user.username,
      password: "",
      phone: user.phone || "",
      role: user.role,
    });
  }

  function closeEditUser() {
    if (saving) return;

    setEditingUser(null);

    setEditForm({
      fullName: "",
      username: "",
      password: "",
      phone: "",
      role: "VIEWER",
    });
  }

  async function handleEditUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!editingUser) return;

    setError("");
    setMessage("");
    setSaving(true);

    try {
      const payload: {
        fullName: string;
        username: string;
        phone: string;
        role: User["role"];
        password?: string;
      } = {
        fullName: editForm.fullName,
        username: editForm.username,
        phone: editForm.phone,
        role: editForm.role,
      };

      if (editForm.password.trim()) {
        payload.password = editForm.password;
      }

      const response = await fetch(`/api/users/${editingUser.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || "Unable to update user");
        return;
      }

      setMessage("User updated successfully.");

      closeEditUser();

      await loadUsers();
    } catch {
      setError("Unable to connect to the server");
    } finally {
      setSaving(false);
    }
  }

  async function toggleUserStatus(user: User) {
    const action = user.isActive ? "deactivate" : "activate";

    const confirmed = window.confirm(
      `Are you sure you want to ${action} ${user.fullName}?`
    );

    if (!confirmed) return;

    setError("");
    setMessage("");

    try {
      const response = await fetch(`/api/users/${user.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          isActive: !user.isActive,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || `Unable to ${action} user`);
        return;
      }

      setMessage(
        `${user.fullName} has been ${user.isActive ? "deactivated" : "activated"}.`
      );

      await loadUsers();
    } catch {
      setError("Unable to connect to the server");
    }
  }

  async function deleteUser(user: User) {
    const confirmed = window.confirm(
      `Are you sure you want to permanently delete ${user.fullName}?`
    );

    if (!confirmed) return;

    setError("");
    setMessage("");

    try {
      const response = await fetch(`/api/users/${user.id}`, {
        method: "DELETE",
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.message || "Unable to delete user");
        return;
      }

      setMessage("User deleted successfully.");

      await loadUsers();
    } catch {
      setError("Unable to connect to the server");
    }
  }

  return (
    <main className="min-h-screen bg-gray-100 p-6">
      <div className="max-w-7xl mx-auto">
        <div className="mb-6">
          <h1 className="text-3xl font-bold">Users</h1>

          <p className="text-gray-500 mt-1">
            Manage ERP users and their access roles.
          </p>
        </div>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {message && (
          <div className="mb-4 rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-700">
            {message}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Create User */}
          <section className="bg-white rounded-xl shadow-sm p-6">
            <h2 className="text-xl font-semibold mb-5">
              Add User
            </h2>

            <form
              onSubmit={handleCreateUser}
              className="space-y-4"
            >
              <input
                type="text"
                placeholder="Full Name"
                value={fullName}
                onChange={(event) =>
                  setFullName(event.target.value)
                }
                className="w-full border rounded-lg px-4 py-3"
                required
              />

              <input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(event) =>
                  setUsername(event.target.value)
                }
                className="w-full border rounded-lg px-4 py-3"
                required
              />

              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(event) =>
                  setPassword(event.target.value)
                }
                className="w-full border rounded-lg px-4 py-3"
                required
              />

              <input
                type="text"
                placeholder="Phone (optional)"
                value={phone}
                onChange={(event) =>
                  setPhone(event.target.value)
                }
                className="w-full border rounded-lg px-4 py-3"
              />

              <select
                value={role}
                onChange={(event) =>
                  setRole(
                    event.target.value as User["role"]
                  )
                }
                className="w-full border rounded-lg px-4 py-3 bg-white"
              >
                <option value="VIEWER">Viewer</option>
                <option value="MANAGER">Manager</option>
                <option value="SUPER_ADMIN">
                  Super Admin
                </option>
              </select>

              <button
                type="submit"
                disabled={creating}
                className="w-full bg-black text-white py-3 rounded-lg disabled:opacity-50"
              >
                {creating
                  ? "Creating..."
                  : "Create User"}
              </button>
            </form>
          </section>

          {/* Users List */}
          <section className="lg:col-span-2 bg-white rounded-xl shadow-sm p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-xl font-semibold">
                  All Users
                </h2>

                <p className="text-sm text-gray-500">
                  {users.length} user
                  {users.length !== 1 ? "s" : ""}
                </p>
              </div>

              <button
                onClick={loadUsers}
                className="border rounded-lg px-4 py-2 text-sm hover:bg-gray-50"
              >
                Refresh
              </button>
            </div>

            {loading ? (
              <p className="text-gray-500">
                Loading users...
              </p>
            ) : users.length === 0 ? (
              <p className="text-gray-500">
                No users found.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left">
                      <th className="py-3 pr-4">
                        Name
                      </th>

                      <th className="py-3 pr-4">
                        Username
                      </th>

                      <th className="py-3 pr-4">
                        Role
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
                    {users.map((user) => (
                      <tr
                        key={user.id}
                        className="border-b"
                      >
                        <td className="py-3 pr-4 font-medium">
                          {user.fullName}
                        </td>

                        <td className="py-3 pr-4">
                          {user.username}
                        </td>

                        <td className="py-3 pr-4">
                          {user.role}
                        </td>

                        <td className="py-3 pr-4">
                          <span
                            className={
                              user.isActive
                                ? "text-green-600"
                                : "text-red-600"
                            }
                          >
                            {user.isActive
                              ? "Active"
                              : "Inactive"}
                          </span>
                        </td>

                        <td className="py-3 pr-4">
                          <div className="flex gap-2 flex-wrap">
                            <button
                              onClick={() =>
                                openEditUser(user)
                              }
                              className="border rounded-lg px-3 py-1.5 text-xs hover:bg-gray-50"
                            >
                              Edit
                            </button>

                            <button
                              onClick={() =>
                                toggleUserStatus(user)
                              }
                              className="border rounded-lg px-3 py-1.5 text-xs hover:bg-gray-50"
                            >
                              {user.isActive
                                ? "Deactivate"
                                : "Activate"}
                            </button>

                            <button
                              onClick={() =>
                                deleteUser(user)
                              }
                              className="border border-red-300 text-red-600 rounded-lg px-3 py-1.5 text-xs hover:bg-red-50"
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

        {/* Edit User Modal */}
        {editingUser && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
            <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-6">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h2 className="text-xl font-semibold">
                    Edit User
                  </h2>

                  <p className="text-sm text-gray-500 mt-1">
                    Update user account details.
                  </p>
                </div>

                <button
                  onClick={closeEditUser}
                  disabled={saving}
                  className="text-gray-500 hover:text-black text-xl"
                >
                  ×
                </button>
              </div>

              <form
                onSubmit={handleEditUser}
                className="space-y-4"
              >
                <input
                  type="text"
                  placeholder="Full Name"
                  value={editForm.fullName}
                  onChange={(event) =>
                    setEditForm({
                      ...editForm,
                      fullName: event.target.value,
                    })
                  }
                  className="w-full border rounded-lg px-4 py-3"
                  required
                />

                <input
                  type="text"
                  placeholder="Username"
                  value={editForm.username}
                  onChange={(event) =>
                    setEditForm({
                      ...editForm,
                      username: event.target.value,
                    })
                  }
                  className="w-full border rounded-lg px-4 py-3"
                  required
                />

                <input
                  type="password"
                  placeholder="New Password (optional)"
                  value={editForm.password}
                  onChange={(event) =>
                    setEditForm({
                      ...editForm,
                      password: event.target.value,
                    })
                  }
                  className="w-full border rounded-lg px-4 py-3"
                />

                <input
                  type="text"
                  placeholder="Phone (optional)"
                  value={editForm.phone}
                  onChange={(event) =>
                    setEditForm({
                      ...editForm,
                      phone: event.target.value,
                    })
                  }
                  className="w-full border rounded-lg px-4 py-3"
                />

                <select
                  value={editForm.role}
                  onChange={(event) =>
                    setEditForm({
                      ...editForm,
                      role: event.target
                        .value as User["role"],
                    })
                  }
                  className="w-full border rounded-lg px-4 py-3 bg-white"
                >
                  <option value="VIEWER">
                    Viewer
                  </option>

                  <option value="MANAGER">
                    Manager
                  </option>

                  <option value="SUPER_ADMIN">
                    Super Admin
                  </option>
                </select>

                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={closeEditUser}
                    disabled={saving}
                    className="flex-1 border rounded-lg py-3 hover:bg-gray-50"
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    disabled={saving}
                    className="flex-1 bg-black text-white rounded-lg py-3 disabled:opacity-50"
                  >
                    {saving
                      ? "Saving..."
                      : "Save Changes"}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}