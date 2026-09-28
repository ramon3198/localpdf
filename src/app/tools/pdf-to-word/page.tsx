import type { Metadata } from "next";
import { PdfToWordScreen } from "./pdf-to-word-screen";

export const metadata: Metadata = {
    title: "PDF a Word — LocalPDF",
    description: "Convierte tu PDF en un documento de Word editable, con su formato. Sin subir el archivo.",
};

export default function PdfToWordPage() {
    return <PdfToWordScreen />;
}
