import type { Metadata } from "next";
import { CompressScreen } from "./compress-screen";

export const metadata: Metadata = {
    title: "Comprimir PDF — LocalPDF",
    description: "Reduce el peso del PDF manteniendo la calidad que necesites.",
};

export default function CompressPage() {
    return <CompressScreen />;
}
