import type { Metadata } from "next";
import { SignScreen } from "./sign-screen";

export const metadata: Metadata = {
    title: "Firmar PDF — LocalPDF",
    description: "Dibuja tu firma y colócala en cualquier página del PDF.",
};

export default function SignPage() {
    return <SignScreen />;
}
