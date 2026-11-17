import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { hasPermission } from "@/lib/permissions";

// GET /api/marketing/contacts/export/excel - mirrors app/api/parties/
// [id]/ledger/excel/route.ts exactly: an HTML <table> served as
// application/vnd.ms-excel, the established "no new dependency" Excel
// export technique already in use elsewhere in this app.
function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function GET() {
  try {
    const currentUser = await getCurrentUser();
    if (!currentUser) return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    if (!hasPermission(currentUser, "marketing.view")) {
      return NextResponse.json({ success: false, message: "Forbidden" }, { status: 403 });
    }

    const contacts = await prisma.marketingContact.findMany({
      where: { mergedIntoId: null },
      orderBy: { lastDate: "desc" },
    });

    const rowsHtml = contacts
      .map(
        (c) => `
      <tr>
        <td>${escapeHtml(c.name)}</td>
        <td>${escapeHtml(c.phone)}</td>
        <td>${escapeHtml(c.roles.join(", "))}</td>
        <td>${escapeHtml(c.city || "")}</td>
        <td>${escapeHtml(c.route || "")}</td>
        <td align="right">${c.biltyCount}</td>
        <td align="right">${Math.round(Number(c.revenue)).toLocaleString()}</td>
        <td>${escapeHtml(c.lastVehicle || "")}</td>
        <td>${c.lastDate.toISOString().slice(0, 10)}</td>
        <td>${c.isBroker ? "Yes" : ""}</td>
        <td>${c.optedOut ? "Yes" : ""}</td>
      </tr>`
      )
      .join("");

    const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8" />
<!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet><x:Name>Contacts</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]-->
<style>
table { border-collapse: collapse; font-family: Arial, sans-serif; font-size: 11px; }
th, td { border: 1px solid #999; padding: 4px 8px; }
th { background: #2563eb; color: #ffffff; }
</style>
</head>
<body>
<h2>AL NAEEM CAR CARRIERS SERVICE - Marketing Contacts</h2>
<br/>
<table>
<thead>
<tr><th>Name</th><th>Phone</th><th>Roles</th><th>City</th><th>Route</th><th>Bilty Count</th><th>Revenue</th><th>Last Vehicle</th><th>Last Date</th><th>Broker</th><th>Opted Out</th></tr>
</thead>
<tbody>
${rowsHtml}
</tbody>
</table>
</body>
</html>`;

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.ms-excel; charset=utf-8",
        "Content-Disposition": "attachment; filename=Marketing-Contacts.xls",
      },
    });
  } catch (error) {
    console.error("Marketing contacts Excel export error:", error);
    return NextResponse.json({ success: false, message: "Unable to generate export" }, { status: 500 });
  }
}
