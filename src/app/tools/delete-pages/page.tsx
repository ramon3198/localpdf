import type { Metadata } from "next";
import { DeletePagesScreen } from "./delete-pages-screen";

export const metadata: Metadata = {
    title: "Eliminar páginas — LocalPDF",
    description: "Quita páginas específicas de un PDF.",
};

export default function DeletePagesPage() {
    return <DeletePagesScreen />;
}
