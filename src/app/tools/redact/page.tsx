import type { Metadata } from "next";
import { RedactScreen } from "./redact-screen";

export const metadata: Metadata = {
    title: "Censurar PDF — LocalPDF",
    description: "Tapa datos sensibles de forma permanente: lo tapado desaparece del archivo.",
};

export default function RedactPage() {
    return <RedactScreen />;
}
