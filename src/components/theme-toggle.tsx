"use client";

import { useEffect, useRef, useState } from "react";
import { Moon02, Sun } from "@untitledui/icons";
import { useTheme } from "next-themes";
import { cx } from "@/utils/cx";

/**
 * Sun/moon toggle with a circular reveal animation via the View Transitions API.
 * Falls back to a smooth CSS transition (configured in globals.css) for browsers
 * that don't support it.
 */
export const ThemeToggle = () => {
    const { resolvedTheme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => setMounted(true), []);

    const handleClick = async () => {
        const next = resolvedTheme === "dark" ? "light" : "dark";
        const doc = document as Document & {
            startViewTransition?: (cb: () => void) => { ready: Promise<void> };
        };

        if (!doc.startViewTransition || !buttonRef.current) {
            setTheme(next);
            return;
        }

        const rect = buttonRef.current.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

        const transition = doc.startViewTransition(() => {
            setTheme(next);
        });
        try {
            await transition.ready;
            document.documentElement.animate(
                {
                    clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`],
                },
                {
                    duration: 450,
                    easing: "cubic-bezier(0.4, 0, 0.2, 1)",
                    pseudoElement: "::view-transition-new(root)",
                },
            );
        } catch {
            /* user navigated mid-animation — ignore */
        }
    };

    const isDark = mounted && resolvedTheme === "dark";

    return (
        <button
            ref={buttonRef}
            type="button"
            aria-label={isDark ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
            aria-pressed={isDark}
            onClick={handleClick}
            className={cx(
                "group relative flex h-9 w-16 shrink-0 cursor-pointer items-center rounded-full bg-secondary p-1 ring-1 ring-secondary outline-focus-ring transition-colors duration-150 ring-inset hover:bg-tertiary focus-visible:outline-2 focus-visible:outline-offset-2",
            )}
        >
            <span
                aria-hidden="true"
                className={cx(
                    "pointer-events-none absolute top-1 left-1 flex size-7 items-center justify-center rounded-full bg-primary text-fg-quaternary shadow-md ring-1 ring-secondary transition-transform duration-300 ease-out ring-inset",
                    isDark ? "translate-x-7" : "translate-x-0",
                )}
            >
                {isDark ? <Moon02 className="size-4" /> : <Sun className="size-4" />}
            </span>
            {/* Decorative icons sitting behind the puck */}
            <span aria-hidden="true" className="ml-1.5 inline-flex size-4 items-center justify-center text-fg-quinary">
                <Sun className="size-3.5" />
            </span>
            <span aria-hidden="true" className="ml-auto mr-1.5 inline-flex size-4 items-center justify-center text-fg-quinary">
                <Moon02 className="size-3.5" />
            </span>
        </button>
    );
};
