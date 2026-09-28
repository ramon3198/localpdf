import type { Metadata } from "next";
import { ProtectScreen } from "./protect-screen";

export const metadata: Metadata = {
    title: "Proteger PDF — LocalPDF",
    description: "Cifra el PDF con una contraseña.",
};

export default function ProtectPage() {
    return <ProtectScreen />;
}
