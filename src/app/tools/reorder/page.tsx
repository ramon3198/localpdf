import type { Metadata } from "next";
import { ReorderScreen } from "./reorder-screen";

export const metadata: Metadata = {
    title: "Reordenar páginas — LocalPDF",
    description: "Arrastra las miniaturas para cambiar el orden de las páginas.",
};

export default function ReorderPage() {
    return <ReorderScreen />;
}
