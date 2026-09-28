"use client";

import type { PropsWithChildren } from "react";
import { useEffect, useState } from "react";
import { X as CloseIcon, Menu02 } from "@untitledui/icons";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
    Button as AriaButton,
    Dialog as AriaDialog,
    DialogTrigger as AriaDialogTrigger,
    Modal as AriaModal,
    ModalOverlay as AriaModalOverlay,
} from "react-aria-components";
import { LocalPdfLogo } from "@/components/foundations/logo/local-pdf-logo";
import { cx } from "@/utils/cx";

export const MobileNavigationHeader = ({ children }: PropsWithChildren) => {
    const pathname = usePathname();
    const [isOpen, setOpen] = useState(false);

    // The drawer lives outside the pages, so close it once a link has navigated.
    useEffect(() => setOpen(false), [pathname]);

    return (
        <AriaDialogTrigger isOpen={isOpen} onOpenChange={setOpen}>
            <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-secondary bg-primary/95 p-3 pl-4 backdrop-blur lg:hidden">
                <Link href="/" aria-label="LocalPDF, inicio" className="rounded-md outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2">
                    <LocalPdfLogo className="h-6" />
                </Link>

                <AriaButton
                    aria-label="Abrir menú"
                    className="group flex items-center justify-center rounded-lg bg-primary p-2 text-fg-secondary outline-focus-ring hover:bg-primary_hover hover:text-fg-secondary_hover focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                    <Menu02 className="size-6 transition duration-200 ease-in-out group-aria-expanded:opacity-0" />
                    <CloseIcon className="absolute size-6 opacity-0 transition duration-200 ease-in-out group-aria-expanded:opacity-100" />
                </AriaButton>
            </header>

            <AriaModalOverlay
                isDismissable
                className={({ isEntering, isExiting }) =>
                    cx(
                        "fixed inset-0 z-50 cursor-pointer bg-overlay/70 pr-16 backdrop-blur-md lg:hidden",
                        isEntering && "duration-300 ease-in-out animate-in fade-in",
                        isExiting && "duration-200 ease-in-out animate-out fade-out",
                    )
                }
            >
                {({ state }) => (
                    <>
                        <AriaButton
                            aria-label="Cerrar menú"
                            onPress={() => state.close()}
                            className="fixed top-2.5 right-3 flex cursor-pointer items-center justify-center rounded-lg p-2 text-fg-white/70 outline-focus-ring hover:bg-white/10 hover:text-fg-white focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                            <CloseIcon className="size-6" />
                        </AriaButton>

                        <AriaModal className="w-full max-w-74 cursor-auto will-change-transform">
                            <AriaDialog aria-label="Menú de herramientas" className="h-dvh outline-hidden focus:outline-hidden">
                                {children}
                            </AriaDialog>
                        </AriaModal>
                    </>
                )}
            </AriaModalOverlay>
        </AriaDialogTrigger>
    );
};
