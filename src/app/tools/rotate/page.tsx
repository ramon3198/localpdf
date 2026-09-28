import type { Metadata } from "next";
import { RotateScreen } from "./rotate-screen";

export const metadata: Metadata = {
    title: "Rotar PDF — LocalPDF",
    description: "Gira páginas individuales o todo el documento, 90° a la vez.",
};

export default function RotatePage() {
    return <RotateScreen />;
}
