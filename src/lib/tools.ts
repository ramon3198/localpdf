import type { FC } from "react";
import {
    Archive,
    Dataflow02,
    Droplets02,
    Edit05,
    Eraser,
    File05,
    FileAttachment02,
    FileCheck02,
    FileLock02,
    FilePlus02,
    FileSearch02,
    FileShield02,
    Image01,
    LayersThree01,
    PenTool02,
    Reflect01,
    Scissors01,
    Type01,
} from "@untitledui/icons";

export type ToolCategory = "organize" | "convert" | "edit" | "security";

export type Tool = {
    slug: string;
    title: string;
    description: string;
    category: ToolCategory;
    icon: FC<{ className?: string }>;
    /** Hex/RGB used for the icon tile tint. Maps to Untitled UI featured-icon colors when possible. */
    color: "brand" | "gray" | "success" | "warning" | "error";
    /** Whether the tool is implemented end-to-end (true) or still a stub (false). */
    available: boolean;
    /** Other words people use for this task (search). */
    keywords: string[];
};

export const categories: Record<ToolCategory, { label: string; description: string }> = {
    organize: {
        label: "Organizar",
        description: "Fusiona, divide y reordena páginas",
    },
    convert: {
        label: "Convertir",
        description: "De y hacia PDF",
    },
    edit: {
        label: "Editar",
        description: "Modifica el contenido del PDF",
    },
    security: {
        label: "Seguridad",
        description: "Protege y firma tus documentos",
    },
};

export const tools: Tool[] = [
    {
        slug: "merge",
        title: "Fusionar PDF",
        description: "Combina varios PDFs en un solo archivo, en el orden que quieras.",
        category: "organize",
        icon: LayersThree01,
        color: "brand",
        available: true,
        keywords: ["unir", "juntar", "combinar", "concatenar", "varios archivos"],
    },
    {
        slug: "split",
        title: "Dividir PDF",
        description: "Separa páginas o extrae rangos en archivos independientes.",
        category: "organize",
        icon: Scissors01,
        color: "brand",
        available: true,
        keywords: ["separar", "partir", "extraer", "cortar", "rango"],
    },
    {
        slug: "rotate",
        title: "Rotar PDF",
        description: "Gira páginas individuales o todo el documento.",
        category: "organize",
        icon: Reflect01,
        color: "gray",
        available: true,
        keywords: ["girar", "voltear", "orientación", "horizontal", "vertical"],
    },
    {
        slug: "delete-pages",
        title: "Eliminar páginas",
        description: "Quita páginas específicas de un PDF.",
        category: "organize",
        icon: Eraser,
        color: "error",
        available: true,
        keywords: ["borrar", "quitar", "suprimir"],
    },
    {
        slug: "reorder",
        title: "Reordenar páginas",
        description: "Arrastra las miniaturas para cambiar el orden del documento.",
        category: "organize",
        icon: Dataflow02,
        color: "brand",
        available: true,
        keywords: ["ordenar", "mover", "cambiar orden", "arrastrar"],
    },
    {
        slug: "compress",
        title: "Comprimir PDF",
        description: "Reduce el peso del archivo manteniendo la calidad.",
        category: "convert",
        icon: Archive,
        color: "warning",
        available: true,
        keywords: ["reducir", "tamaño", "peso", "optimizar", "correo"],
    },
    {
        slug: "pdf-to-image",
        title: "PDF a Imagen",
        description: "Convierte cada página a PNG o JPG.",
        category: "convert",
        icon: Image01,
        color: "success",
        available: true,
        keywords: ["jpg", "jpeg", "png", "foto", "exportar"],
    },
    {
        slug: "image-to-pdf",
        title: "Imagen a PDF",
        description: "Crea un PDF a partir de imágenes JPG o PNG.",
        category: "convert",
        icon: FilePlus02,
        color: "success",
        available: true,
        keywords: ["jpg", "jpeg", "png", "foto", "escaneo"],
    },
    {
        slug: "pdf-to-word",
        title: "PDF a Word",
        description: "Convierte tu PDF en un documento de Word editable, con su formato.",
        category: "convert",
        icon: FileAttachment02,
        color: "brand",
        available: true,
        keywords: ["docx", "doc", "office", "editable"],
    },
    {
        slug: "edit",
        title: "Editar PDF",
        description: "Cambia el texto del PDF con su misma fuente y añade texto, formas o imágenes.",
        category: "edit",
        icon: Edit05,
        color: "brand",
        available: true,
        keywords: ["texto", "cambiar", "corregir", "escribir", "modificar", "fuente"],
    },
    {
        slug: "annotate",
        title: "Anotar PDF",
        description: "Subraya, resalta y comenta sobre el documento.",
        category: "edit",
        icon: Type01,
        color: "warning",
        available: true,
        keywords: ["resaltar", "resaltado", "subrayar", "tachar", "tachado", "comentar", "nota", "marcar"],
    },
    {
        slug: "watermark",
        title: "Marca de agua",
        description: "Añade un sello o texto en todas las páginas.",
        category: "edit",
        icon: Droplets02,
        color: "brand",
        available: true,
        keywords: ["sello", "logo", "confidencial"],
    },
    {
        slug: "ocr",
        title: "OCR (escaneado)",
        description: "Hace el texto buscable en PDFs escaneados.",
        category: "edit",
        icon: FileSearch02,
        color: "error",
        available: true,
        keywords: ["reconocer", "texto", "buscable", "seleccionable", "escanear"],
    },
    {
        slug: "protect",
        title: "Proteger PDF",
        description: "Cifra el PDF con una contraseña.",
        category: "security",
        icon: FileLock02,
        color: "error",
        available: true,
        keywords: ["contraseña", "clave", "cifrar", "encriptar", "bloquear"],
    },
    {
        slug: "unlock",
        title: "Desproteger PDF",
        description: "Quita la contraseña o las restricciones de impresión y copia.",
        category: "security",
        icon: File05,
        color: "gray",
        available: true,
        keywords: ["quitar contraseña", "desbloquear", "clave", "descifrar"],
    },
    {
        slug: "sign",
        title: "Firmar PDF",
        description: "Coloca tu firma manuscrita en cualquier página.",
        category: "security",
        icon: PenTool02,
        color: "brand",
        available: true,
        keywords: ["firma", "rúbrica", "manuscrita"],
    },
    {
        slug: "redact",
        title: "Censurar PDF",
        description: "Tapa información sensible de forma permanente.",
        category: "security",
        icon: FileShield02,
        color: "error",
        available: true,
        keywords: ["ocultar", "tachar", "anonimizar", "datos sensibles", "redactar"],
    },
];

export const getTool = (slug: string): Tool | undefined => tools.find((t) => t.slug === slug);

export const toolsByCategory = (category: ToolCategory): Tool[] => tools.filter((t) => t.category === category);

const normalize = (text: string) =>
    text
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase();

/** Tools matching every word of the query (accents and case ignored), title matches first. */
export const searchTools = (query: string): Tool[] => {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    if (!words.length) return tools;
    const scored = tools
        .map((tool) => {
            const title = normalize(tool.title);
            const haystack = normalize([tool.title, tool.description, categories[tool.category].label, ...tool.keywords].join(" "));
            if (!words.every((word) => haystack.includes(word))) return null;
            return { tool, score: words.filter((word) => title.includes(word)).length };
        })
        .filter((entry): entry is { tool: Tool; score: number } => entry !== null);
    return scored.sort((a, b) => b.score - a.score).map((entry) => entry.tool);
};

export { FileCheck02 };
