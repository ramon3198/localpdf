import type { Metadata } from "next";
import { EditScreen } from "./edit-screen";

export const metadata: Metadata = {
    title: "Editar PDF — LocalPDF",
    description: "Cambia el texto de tu PDF con su misma fuente y añade texto, formas, dibujos e imágenes.",
};

export default function EditPage() {
    return <EditScreen mode="edit" />;
}
