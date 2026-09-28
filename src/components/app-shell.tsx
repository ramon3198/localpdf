"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, HomeLine, SearchLg, ShieldTick } from "@untitledui/icons";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MobileNavigationHeader } from "@/components/application/app-navigation/base-components/mobile-header";
import { NavItemBase } from "@/components/application/app-navigation/base-components/nav-item";
import { Badge } from "@/components/base/badges/badges";
import { Input } from "@/components/base/input/input";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { LocalPdfLogo } from "@/components/foundations/logo/local-pdf-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { type Tool, type ToolCategory, categories, getTool, searchTools, toolsByCategory } from "@/lib/tools";
import { cx } from "@/utils/cx";

const MAIN_SIDEBAR_WIDTH = 280;

const toolHref = (tool: Tool) => `/tools/${tool.slug}`;

const ToolLink = ({ tool, activeUrl, onNavigate }: { tool: Tool; activeUrl: string; onNavigate?: () => void }) => (
    <li className="py-px">
        <NavItemBase
            icon={tool.icon}
            href={toolHref(tool)}
            type="link"
            current={activeUrl === toolHref(tool)}
            badge={tool.available ? undefined : "Pronto"}
            onClick={onNavigate}
        >
            {tool.title}
        </NavItemBase>
    </li>
);

const Sidebar = ({ activeUrl }: { activeUrl: string }) => {
    const router = useRouter();
    const [query, setQuery] = useState("");
    const searchRef = useRef<HTMLInputElement>(null);
    const results = query.trim() ? searchTools(query) : null;

    // Ctrl+K / Cmd+K, or "/" outside a text field, jumps to the tool search.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const typing = !!target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName));
            if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") || (event.key === "/" && !typing)) {
                event.preventDefault();
                searchRef.current?.focus();
                searchRef.current?.select();
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, []);

    const clear = () => setQuery("");

    const content = (
        <aside
            style={{ "--width": `${MAIN_SIDEBAR_WIDTH}px` } as React.CSSProperties}
            className="flex scrollbar-subtle h-full w-full max-w-full flex-col overflow-auto border-secondary bg-primary pt-4 lg:w-(--width) lg:border-r lg:pt-5"
        >
            <div className="flex flex-col gap-4 px-4 lg:px-5">
                <Link
                    href="/"
                    aria-label="LocalPDF, inicio"
                    className="w-max rounded-md outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2"
                >
                    <LocalPdfLogo className="h-7" />
                </Link>
                <Input
                    ref={searchRef}
                    size="sm"
                    aria-label="Buscar herramienta"
                    placeholder="Buscar herramienta"
                    icon={SearchLg}
                    shortcut="Ctrl K"
                    value={query}
                    onChange={setQuery}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && results?.length) {
                            router.push(toolHref(results[0]));
                            clear();
                            searchRef.current?.blur();
                        } else if (event.key === "Escape") {
                            clear();
                        }
                    }}
                />
            </div>

            <nav aria-label="Herramientas" className="mt-3 flex flex-1 flex-col gap-1 pb-4">
                {results ? (
                    results.length ? (
                        <div className="flex flex-col gap-0.5">
                            <div className="px-5 pt-2 pb-1 text-xs font-semibold text-quaternary">
                                {results.length === 1 ? "1 herramienta" : `${results.length} herramientas`}
                            </div>
                            <ul className="flex flex-col px-2">
                                {results.map((tool) => (
                                    <ToolLink key={tool.slug} tool={tool} activeUrl={activeUrl} onNavigate={clear} />
                                ))}
                            </ul>
                        </div>
                    ) : (
                        <div className="mx-4 flex flex-col gap-1 rounded-lg bg-secondary px-3 py-3 text-sm">
                            <p className="font-semibold text-secondary">Sin resultados</p>
                            <p className="text-tertiary">Prueba con otra palabra, por ejemplo “unir”, “firma” o “contraseña”.</p>
                        </div>
                    )
                ) : (
                    <>
                        <ul className="flex flex-col px-2">
                            <li className="py-px">
                                <NavItemBase icon={HomeLine} href="/" type="link" current={activeUrl === "/"}>
                                    Todas las herramientas
                                </NavItemBase>
                            </li>
                        </ul>
                        {(Object.keys(categories) as ToolCategory[]).map((category) => (
                            <div key={category} className="flex flex-col gap-0.5">
                                <div className="px-5 pt-3 pb-1 text-xs font-semibold tracking-wide text-quaternary uppercase">{categories[category].label}</div>
                                <ul className="flex flex-col px-2">
                                    {toolsByCategory(category).map((tool) => (
                                        <ToolLink key={tool.slug} tool={tool} activeUrl={activeUrl} />
                                    ))}
                                </ul>
                            </div>
                        ))}
                    </>
                )}
            </nav>

            <div className="mt-auto flex flex-col gap-3 border-t border-secondary px-4 py-3 lg:py-4">
                <div className="flex items-center justify-between gap-2 rounded-lg bg-secondary px-3 py-2 ring-1 ring-secondary ring-inset">
                    <span className="text-xs font-medium text-secondary">Tema</span>
                    <ThemeToggle />
                </div>
                <div className="ring-success flex items-start gap-2 rounded-lg bg-success-primary px-3 py-2 text-xs font-medium text-success-primary ring-1 ring-inset">
                    <ShieldTick aria-hidden="true" className="mt-px size-4 shrink-0" />
                    <span>100% local: tus archivos nunca salen de este equipo.</span>
                </div>
            </div>
        </aside>
    );

    return (
        <>
            <MobileNavigationHeader>{content}</MobileNavigationHeader>
            <div className="hidden lg:fixed lg:inset-y-0 lg:left-0 lg:z-20 lg:flex">{content}</div>
            <div style={{ width: MAIN_SIDEBAR_WIDTH }} className="hidden shrink-0 lg:block" />
        </>
    );
};

export const AppShell = ({ children }: { children: ReactNode }) => {
    const pathname = usePathname() ?? "/";

    // A file dropped outside a drop zone would make the browser open it and throw away the user's work.
    useEffect(() => {
        const guard = (event: DragEvent) => {
            if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
        };
        window.addEventListener("dragover", guard);
        window.addEventListener("drop", guard);
        return () => {
            window.removeEventListener("dragover", guard);
            window.removeEventListener("drop", guard);
        };
    }, []);

    return (
        // Column on phones (header above the page), row on large screens (sidebar beside it).
        <div className="flex min-h-dvh flex-col lg:flex-row">
            <Sidebar activeUrl={pathname} />
            <main className="flex min-w-0 flex-1 flex-col">{children}</main>
        </div>
    );
};

/** Title block of every page. On a tool page it adds the tool's icon and a path back to the tool list. */
export const PageHeader = ({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) => {
    const pathname = usePathname() ?? "";
    const tool = pathname.startsWith("/tools/") ? getTool(pathname.split("/")[2] ?? "") : undefined;
    return (
        <header className="border-b border-secondary bg-primary px-4 pt-4 pb-5 md:px-6 md:pt-5 md:pb-6 lg:px-10">
            {tool && (
                <nav aria-label="Ruta" className="mb-4 flex items-center gap-1.5 text-sm font-medium text-tertiary">
                    <Link
                        href="/"
                        className="rounded-sm outline-focus-ring transition duration-100 ease-linear hover:text-secondary focus-visible:outline-2 focus-visible:outline-offset-2"
                    >
                        Inicio
                    </Link>
                    <ChevronRight aria-hidden="true" className="size-4 text-fg-quaternary" />
                    <span>{categories[tool.category].label}</span>
                </nav>
            )}
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-4">
                    {tool && <FeaturedIcon icon={tool.icon} color={tool.color} theme="modern" size="lg" className="shrink-0 max-md:hidden" />}
                    <div className="flex min-w-0 flex-col gap-1">
                        <h1 className="text-display-xs font-semibold text-primary md:text-display-sm">{title}</h1>
                        {description && <p className="text-md text-tertiary">{description}</p>}
                    </div>
                </div>
                {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
            </div>
        </header>
    );
};

export const LocalBadge = () => (
    <Badge color="success" type="pill-color" size="md">
        <span className="inline-flex items-center gap-1">
            <ShieldTick aria-hidden="true" className="size-3.5" />
            Procesado local
        </span>
    </Badge>
);
