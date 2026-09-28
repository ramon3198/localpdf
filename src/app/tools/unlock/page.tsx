import type { Metadata } from "next";
import { UnlockScreen } from "./unlock-screen";

export const metadata: Metadata = {
    title: "Desproteger PDF — LocalPDF",
    description: "Quita la contraseña o las restricciones de impresión y copia de un PDF.",
};

export default function UnlockPage() {
    return <UnlockScreen />;
}
