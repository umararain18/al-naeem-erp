"use client";

import { useParams } from "next/navigation";
import CarrierSlipPage from "@/components/own-carrier/CarrierSlipPage";

export default function ViewEditCarrierSlipPage() {
  const params = useParams<{ id: string; slipId: string }>();
  return <CarrierSlipPage carrierId={params.id} slipId={params.slipId} />;
}
