import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { AppShell } from "@/components/app-shell";
import { RouteProvider } from "@/providers/router-provider";
import { Theme } from "@/providers/theme";
import "@/styles/globals.css";
import { cx } from "@/utils/cx";

const inter = Inter({
    subsets: ["latin"],
    display: "swap",
    variable: "--font-inter",
});

export const metadata: Metadata = {
    title: "LocalPDF — Herramientas PDF 100% locales",
    description:
        "Fusiona, divide, comprime, convierte, edita y firma archivos PDF directamente en tu equipo. Sin subidas, sin servidor.",
};

export const viewport: Viewport = {
    themeColor: "#7f56d9",
    colorScheme: "light dark",
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="es" suppressHydrationWarning>
            <body className={cx(inter.variable, "bg-secondary antialiased")}>
                <RouteProvider>
                    <Theme>
                        <AppShell>{children}</AppShell>
                    </Theme>
                </RouteProvider>
            </body>
        </html>
    );
}
