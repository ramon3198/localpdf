import type { Metadata } from "next";
import { MergeScreen } from "./merge-screen";

export const metadata: Metadata = {
    title: "Fusionar PDF — LocalPDF",
    description: "Combina varios PDFs en un solo archivo, en el orden que quieras. 100% local.",
};

export default function MergePage() {
    return <MergeScreen />;
}
