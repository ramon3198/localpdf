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
    /** What the person will be able to choose or do once a file is open: shown under the empty drop zone. */
    intro?: ToolPoint[];
};

export type ToolPoint = { title: string; text: string };

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
        intro: [
            { title: "Varios PDF a la vez", text: "Suelta dos o más archivos; puedes añadir más después." },
            { title: "Tú eliges el orden", text: "Arrastra los archivos o usa las flechas antes de unirlos." },
            { title: "Un solo PDF", text: "Verás cuántas páginas tendrá el resultado antes de fusionar." },
        ],
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
        intro: [
            { title: "Elige páginas", text: "Marca las páginas que quieres separar del resto." },
            { title: "Por rangos", text: "Escribe rangos como 1-3, 5, 8-10: juntos en un PDF o cada uno en el suyo." },
            { title: "Todas por separado", text: "Un PDF por página, descargados juntos en un ZIP." },
        ],
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
        intro: [
            { title: "Página a página", text: "Gira cada página con sus botones o haciendo clic en ella." },
            { title: "Todas a la vez", text: "Gira el documento entero a la izquierda o a la derecha." },
            { title: "Con vista previa", text: "Ves cómo queda cada página antes de guardar." },
        ],
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
        intro: [
            { title: "Marca lo que sobra", text: "Haz clic en las páginas que quieres eliminar." },
            { title: "Varias seguidas", text: "Con Mayús + clic marcas un tramo entero; también puedes invertir la selección." },
            { title: "Un PDF nuevo", text: "Descargas el documento sin esas páginas; tu archivo original no cambia." },
        ],
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
        intro: [
            { title: "Arrastra las páginas", text: "Mueve las miniaturas hasta dejarlas en el orden que quieras." },
            { title: "O usa las flechas", text: "Cada página tiene flechas para moverla una posición." },
            { title: "Invertir de un clic", text: "Da la vuelta a todo el documento, o vuelve al orden original." },
        ],
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
        intro: [
            { title: "Tres niveles", text: "Ligero no cambia la calidad, Equilibrado reduce las imágenes y Fuerte convierte cada página en una imagen." },
            { title: "Tú decides la calidad", text: "En Equilibrado y Fuerte ajustas la calidad de imagen y la resolución." },
            { title: "Compara antes de descargar", text: "Verás el original junto al resultado y cuánto peso ahorras." },
        ],
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
        intro: [
            { title: "PNG o JPG", text: "Elige el formato de las imágenes." },
            { title: "Resolución a tu medida", text: "De 75 a 300 ppp, según para qué las necesites." },
            { title: "Todas o algunas páginas", text: "Una página da una imagen; varias, un ZIP con todas." },
        ],
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
        intro: [
            { title: "Varias imágenes", text: "Suelta fotos JPG o PNG y ponlas en el orden que quieras." },
            { title: "Tamaño de página", text: "A4, Carta o el tamaño original de cada imagen." },
            { title: "Ajustar o llenar", text: "La imagen entera dentro de la página, o cubriéndola por completo." },
        ],
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
        intro: [
            { title: "Tres tipos de conversión", text: "Automático, Texto editable o Diseño exacto." },
            { title: "Páginas escaneadas", text: "Puede reconocer su texto (OCR) en seis idiomas." },
            { title: "Todas o algunas páginas", text: "Descargas un .docx que se abre en Word." },
        ],
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
        intro: [
            { title: "Cambia el texto", text: "Haz clic en cualquier línea y reescríbela con su misma fuente." },
            { title: "Añade contenido", text: "Texto nuevo, dibujo a mano, rectángulos e imágenes." },
            { title: "Deshacer y rehacer", text: "Nada se guarda hasta que aplicas los cambios." },
        ],
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
        intro: [
            { title: "Resalta, subraya y tacha", text: "Marca el documento con el color que elijas." },
            { title: "Notas y dibujo", text: "Añade notas o dibuja a mano sobre la página." },
            { title: "Deshacer y rehacer", text: "Corrige cualquier marca antes de guardar las anotaciones." },
        ],
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
        intro: [
            { title: "Tu texto", text: "Por ejemplo BORRADOR o CONFIDENCIAL, igual en todas las páginas." },
            { title: "Posición y aspecto", text: "Diagonal, centro, arriba o abajo; con el color, el tamaño y la opacidad que elijas." },
            { title: "Vista previa en vivo", text: "Ves cómo queda en cada página antes de aplicarla." },
        ],
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
        intro: [
            { title: "Seis idiomas", text: "Español, inglés, francés, alemán, italiano y portugués; puedes elegir varios." },
            { title: "PDF buscable o solo texto", text: "Conserva las páginas con texto seleccionable, o quédate solo con el texto." },
            { title: "Internet la primera vez", text: "Se descargan el motor y los idiomas; el documento no sale de tu equipo." },
        ],
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
        intro: [
            { title: "Contraseña para abrirlo", text: "Con un medidor de seguridad mientras la escribes." },
            { title: "Restricciones opcionales", text: "Puedes impedir la impresión y la copia del texto." },
            { title: "Guárdala bien", text: "Si la olvidas, no hay forma de recuperarla ni de abrir el documento." },
        ],
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
        intro: [
            { title: "Quita la contraseña", text: "Escríbela una vez y descarga el PDF sin protección." },
            { title: "Quita las restricciones", text: "Vuelve a permitir imprimir y copiar el texto." },
            { title: "Sin salir de tu equipo", text: "La contraseña no se envía a ningún sitio. La protección con certificado no se puede quitar." },
        ],
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
        intro: [
            { title: "Tres formas de firmar", text: "Dibuja la firma, escribe tu nombre o sube una imagen." },
            { title: "Colócala donde quieras", text: "Arrástrala y cambia su tamaño; puedes firmar en varias páginas." },
            { title: "Tinta negra o azul", text: "Y si subes una imagen, se le puede quitar el fondo blanco." },
        ],
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
        intro: [
            { title: "Marca las zonas", text: "Arrastra sobre lo que quieres tapar, o tapa la página entera." },
            { title: "Es permanente", text: "Lo tapado no se puede recuperar del PDF nuevo." },
            { title: "Páginas como imagen", text: "Las páginas censuradas se guardan como imagen: su texto deja de ser seleccionable." },
        ],
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
