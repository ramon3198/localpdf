import type { Metadata } from "next";
import { OcrScreen } from "./ocr-screen";

export const metadata: Metadata = {
    title: "OCR — LocalPDF",
    description: "Convierte PDFs escaneados en texto buscable.",
};

export default function OcrPage() {
    return <OcrScreen />;
}
