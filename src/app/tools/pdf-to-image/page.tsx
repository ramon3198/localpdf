import type { Metadata } from "next";
import { PdfToImageScreen } from "./pdf-to-image-screen";

export const metadata: Metadata = {
    title: "PDF a Imagen — LocalPDF",
    description: "Convierte cada página de tu PDF a PNG o JPG.",
};

export default function PdfToImagePage() {
    return <PdfToImageScreen />;
}
