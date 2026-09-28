import type { Metadata } from "next";
import { WatermarkScreen } from "./watermark-screen";

export const metadata: Metadata = {
    title: "Marca de agua — LocalPDF",
    description: "Añade un texto sobrepuesto en todas las páginas del PDF.",
};

export default function WatermarkPage() {
    return <WatermarkScreen />;
}
