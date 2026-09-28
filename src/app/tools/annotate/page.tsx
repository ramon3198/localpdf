import type { Metadata } from "next";
import { EditScreen } from "../edit/edit-screen";

export const metadata: Metadata = {
    title: "Anotar PDF — LocalPDF",
    description: "Resalta, subraya, tacha y añade notas a tu PDF.",
};

export default function AnnotatePage() {
    return <EditScreen mode="annotate" />;
}
