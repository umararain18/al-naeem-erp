export function getBiltyShareMessage({
  biltyNo,
  from,
  to,
}: {
  biltyNo: string;
  from: string;
  to: string;
}) {
  return [
    "Assalam-o-Alaikum,",
    "",
    "Al Naeem Car Carriers Service",
    "",
    `Bilty No: ${biltyNo}`,
    `Route: ${from} → ${to}`,
    "",
    "Please find the attached Bilty document.",
    "",
    "Thank you.",
  ].join("\n");
}

export function getChallanShareMessage({
  challanNo,
  loadingDate,
}: {
  challanNo: string;
  loadingDate: string;
}) {
  return [
    "Assalam-o-Alaikum,",
    "",
    "Al Naeem Car Carriers Service",
    "",
    `Challan No: ${challanNo}`,
    `Loading Date: ${loadingDate}`,
    "",
    "Please find the attached Challan document.",
    "",
    "Thank you.",
  ].join("\n");
}
