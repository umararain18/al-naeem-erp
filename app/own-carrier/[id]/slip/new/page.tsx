"use client";

import { useParams } from "next/navigation";
import CarrierSlipPage from "@/components/own-carrier/CarrierSlipPage";

export default function NewCarrierSlipPage() {
  const params = useParams<{ id: string }>();
  return <CarrierSlipPage carrierId={params.id} />;
}
