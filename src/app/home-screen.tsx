"use client";

import { useState } from "react";
import { ArrowRight, Lock01, SearchLg, ShieldTick, Zap } from "@untitledui/icons";
import Link from "next/link";
import { Badge } from "@/components/base/badges/badges";
import { Input } from "@/components/base/input/input";
import { FeaturedIcon } from "@/components/foundations/featured-icon/featured-icon";
import { type Tool, type ToolCategory, categories, searchTools, toolsByCategory } from "@/lib/tools";
import { cx } from "@/utils/cx";

const PROMISES = [
    { icon: ShieldTick, title: "Privado", text: "Tus archivos no se suben a ningún servidor." },
    { icon: Zap, title: "Rápido", text: "Todo ocurre en tu navegador, sin esperas de subida." },
    { icon: Lock01, title: "Sin registro", text: "Abre una herramienta y úsala. Sin cuentas." },
];

/** A row, not a tile: icon beside the text, so the whole catalogue fits in a screen or two. */
const ToolCard = ({ tool }: { tool: Tool }) => (
    <Link
        href={`/tools/${tool.slug}`}
        className={cx(
            "group relative flex h-full items-start gap-3 rounded-xl bg-primary p-3.5 ring-1 ring-secondary outline-focus-ring transition duration-150 ease-out ring-inset hover:-translate-y-0.5 hover:shadow-lg hover:ring-brand focus-visible:outline-2 focus-visible:outline-offset-2",
            !tool.available && "bg-secondary_subtle",
        )}
    >
        <FeaturedIcon icon={tool.icon} color={tool.color} theme="modern" size="md" className="shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h3 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-primary">
                {tool.title}
                {!tool.available && (
                    <Badge color="gray" type="pill-color" size="sm">
                        Próximamente
                    </Badge>
                )}
            </h3>
            <p className="text-sm text-tertiary">{tool.description}</p>
        </div>
        {tool.available && (
            <ArrowRight
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-fg-quaternary opacity-0 transition duration-150 ease-out group-hover:translate-x-0.5 group-hover:text-fg-brand-primary group-hover:opacity-100"
            />
        )}
    </Link>
);

const DemoVideo = ({ className }: { className?: string }) => (
    <figure className={cx("flex flex-col gap-2", className)}>
        <video
            controls
            playsInline
            preload="none"
            poster="/video/localpdf-demo.jpg"
            aria-label="Video: LocalPDF en 15 segundos"
            className="aspect-video w-full rounded-2xl bg-secondary shadow-lg ring-1 ring-secondary"
        >
            <source src="/video/localpdf-demo.mp4" type="video/mp4" />
        </video>
        <figcaption className="text-sm text-tertiary">LocalPDF en 15 segundos.</figcaption>
    </figure>
);

const ToolGrid = ({ items }: { items: Tool[] }) => (
    <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 sm:gap-3 xl:grid-cols-3">
        {items.map((tool) => (
            <ToolCard key={tool.slug} tool={tool} />
        ))}
    </div>
);

export const HomeScreen = () => {
    const [query, setQuery] = useState("");
    const [category, setCategory] = useState<ToolCategory | null>(null);
    const searching = query.trim().length > 0;
    const matches = searchTools(query).filter((tool) => !category || tool.category === category);
    const shownCategories = (Object.keys(categories) as ToolCategory[]).filter((c) => !category || c === category);

    return (
        <div className="flex flex-col">
            {/* Kept short: the tools are what people came for, and they start right below. */}
            <section className="border-b border-secondary bg-primary px-4 py-6 md:px-6 lg:px-10 lg:py-8">
                <div className="mx-auto flex max-w-6xl flex-col gap-5">
                    <div className="flex flex-col items-start gap-2">
                        <Badge color="brand" type="pill-color" size="sm">
                            <span className="inline-flex items-center gap-1.5">
                                <ShieldTick aria-hidden="true" className="size-3.5" />
                                100% local · sin subir archivos
                            </span>
                        </Badge>
                        <h1 className="text-display-xs font-semibold tracking-tight text-primary md:text-display-sm">
                            ¿Qué quieres hacer con tu <span className="text-fg-brand-primary">PDF</span>?
                        </h1>
                        <p className="max-w-2xl text-md text-tertiary">
                            Une, divide, comprime, convierte, edita y firma en tu navegador. Nada sale de tu equipo.
                        </p>
                    </div>

                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                        <div className="w-full lg:max-w-sm">
                            <Input
                                size="md"
                                aria-label="Buscar herramienta"
                                placeholder="Busca: unir, firmar, contraseña…"
                                icon={SearchLg}
                                value={query}
                                onChange={setQuery}
                                onKeyDown={(event) => event.key === "Escape" && setQuery("")}
                            />
                        </div>
                        {/* One line on phones too: it scrolls sideways instead of taking a second row. */}
                        <div
                            role="group"
                            aria-label="Filtrar por categoría"
                            className="-mx-4 scrollbar-hide flex gap-2 overflow-x-auto px-4 py-0.5 md:mx-0 md:flex-wrap md:overflow-visible md:px-0"
                        >
                            {[null, ...(Object.keys(categories) as ToolCategory[])].map((c) => {
                                const active = category === c;
                                return (
                                    <button
                                        key={c ?? "all"}
                                        type="button"
                                        aria-pressed={active}
                                        onClick={() => setCategory(c)}
                                        className={cx(
                                            "min-h-10 shrink-0 rounded-full px-3.5 text-sm font-semibold ring-1 outline-focus-ring transition duration-100 ease-linear ring-inset focus-visible:outline-2 focus-visible:outline-offset-2 md:min-h-9",
                                            active
                                                ? "bg-brand-solid text-white ring-transparent hover:bg-brand-solid_hover"
                                                : "bg-primary text-secondary ring-primary hover:bg-primary_hover",
                                        )}
                                    >
                                        {c ? categories[c].label : "Todas"}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </section>

            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-6 md:px-6 lg:px-10 lg:py-8">
                {searching ? (
                    matches.length ? (
                        <section className="flex flex-col gap-4" aria-live="polite">
                            <h2 className="text-sm font-semibold text-tertiary">
                                {matches.length === 1 ? "1 herramienta" : `${matches.length} herramientas`} para “{query.trim()}”
                            </h2>
                            <ToolGrid items={matches} />
                        </section>
                    ) : (
                        <div
                            className="flex flex-col items-center gap-2 rounded-2xl bg-primary px-6 py-12 text-center ring-1 ring-secondary ring-inset"
                            aria-live="polite"
                        >
                            <FeaturedIcon icon={SearchLg} color="gray" theme="modern" size="lg" />
                            <p className="mt-2 text-md font-semibold text-primary">No hay herramientas para “{query.trim()}”</p>
                            <p className="text-sm text-tertiary">Prueba con otra palabra, como “unir”, “imagen”, “firma” o “contraseña”.</p>
                        </div>
                    )
                ) : (
                    shownCategories.map((c) => (
                        <section key={c} className="flex flex-col gap-3">
                            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                                <h2 className="text-lg font-semibold text-primary">{categories[c].label}</h2>
                                <p className="text-sm text-tertiary">{categories[c].description}</p>
                            </div>
                            <ToolGrid items={toolsByCategory(c)} />
                        </section>
                    ))
                )}

                {!searching && (
                    <section className="flex flex-col gap-3 border-t border-secondary pt-8">
                        <h2 className="text-lg font-semibold text-primary">Míralo en acción</h2>
                        <DemoVideo className="max-w-2xl" />
                    </section>
                )}

                <section aria-label="Por qué LocalPDF" className="grid grid-cols-1 gap-4 border-t border-secondary pt-8 md:grid-cols-3">
                    {PROMISES.map(({ icon, title, text }) => (
                        <div key={title} className="flex items-start gap-3">
                            <FeaturedIcon icon={icon} color="brand" theme="light" size="md" />
                            <div className="flex flex-col gap-0.5">
                                <p className="text-sm font-semibold text-primary">{title}</p>
                                <p className="text-sm text-tertiary">{text}</p>
                            </div>
                        </div>
                    ))}
                </section>
            </div>
        </div>
    );
};
