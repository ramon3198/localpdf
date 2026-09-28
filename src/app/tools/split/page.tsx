import type { Metadata } from "next";
import { SplitScreen } from "./split-screen";

export const metadata: Metadata = {
    title: "Dividir PDF — LocalPDF",
    description: "Separa páginas o extrae rangos en archivos independientes.",
};

export default function SplitPage() {
    return <SplitScreen />;
}
