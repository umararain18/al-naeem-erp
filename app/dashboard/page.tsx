import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";
import { redirect } from "next/navigation";
import Link from "next/link";
import LogoutButton from "@/components/LogoutButton";

export default async function DashboardPage() {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <main className="min-h-screen bg-gray-100">
      <header className="bg-white border-b px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Al Naeem ERP</h1>
            <p className="text-sm text-gray-500">Dashboard</p>
          </div>

          <div className="flex items-center gap-4">
            {hasPermission(user, "accountingTransactions.binView") && (
              <Link
                href="/accounting-transaction-bin"
                className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50"
              >
                Bin
              </Link>
            )}

            <div className="text-sm text-gray-600">
              Welcome, {user.username}
            </div>

            <LogoutButton />
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto p-6">
        <h2 className="text-xl font-semibold mb-6">
          Business Overview
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500">Total Bilty</p>
            <p className="text-3xl font-bold mt-2">0</p>
          </div>

          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500">Today's Bookings</p>
            <p className="text-3xl font-bold mt-2">0</p>
          </div>

          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500">Receivable</p>
            <p className="text-3xl font-bold mt-2">Rs. 0</p>
          </div>

          <div className="bg-white rounded-xl p-5 shadow-sm">
            <p className="text-sm text-gray-500">Payable</p>
            <p className="text-3xl font-bold mt-2">Rs. 0</p>
          </div>
        </div>

        <div className="mt-6 bg-white rounded-xl p-6 shadow-sm">
          <h3 className="font-semibold text-lg">Quick Actions</h3>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
            <button className="border rounded-lg px-4 py-3 hover:bg-gray-50">
              New Bilty
            </button>

            <button className="border rounded-lg px-4 py-3 hover:bg-gray-50">
              New Challan
            </button>

            <button className="border rounded-lg px-4 py-3 hover:bg-gray-50">
              Customers
            </button>

            <button className="border rounded-lg px-4 py-3 hover:bg-gray-50">
              Reports
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
