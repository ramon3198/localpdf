import type { Metadata } from "next";
import { ImageToPdfScreen } from "./image-to-pdf-screen";

export const metadata: Metadata = {
    title: "Imagen a PDF — LocalPDF",
    description: "Crea un PDF a partir de imágenes JPG o PNG.",
};

export default function ImageToPdfPage() {
    return <ImageToPdfScreen />;
}
