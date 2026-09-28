/** Font family / weight / slant / class inference from names (fallback when a PDF lacks descriptor data). */

/** Numeric weight class (100–900) from a font name. */
export const weightOf = (s: string): number => {
    const n = s.toLowerCase().replace(/[\s_-]/g, "");
    if (/(thin|hairline)/.test(n)) return 100;
    if (/(extralight|ultralight)/.test(n)) return 200;
    if (/(semibold|demibold|demi)/.test(n)) return 600;
    if (/(extrabold|ultrabold)/.test(n)) return 800;
    if (/(black|heavy)/.test(n)) return 900;
    if (/bold/.test(n)) return 700;
    if (/medium/.test(n)) return 500;
    if (/light/.test(n)) return 300;
    return 400;
};

const SANS =
    /(sans|arial|helvetica|verdana|tahoma|segoe|roboto|calibri|inter|lato|montserrat|gothic|grotesk|frutiger|univers|franklin|futura|avenir|nunito|poppins|raleway|ubuntu|anton|bebas|oswald|barlow|rubik|karla|mulish|manrope|figtree|archivo|kanit|heebo|outfit|lexend|spartan|titillium|josefin|quicksand|cabin|dmsans|worksans|opensans|firasans|ptsans|notosans|gotham|proxima|myriad|optima|candara|corbel|trebuchet|lucidasans|lucidagrande|geneva|sfpro|aptos|dinpro|dinnext|bahnschrift|arimo|carlito|nimbussan|heros|^cmss|^lmsans)/;
const SERIF =
    /(times|serif|georgia|garamond|cambria|book|roman|minion|palatino|baskerville|caslon|didot|merriweather|charis|charter|playfair|lora|crimson|cormorant|slab|tinos|caladea|gelasio|bodoni|constantia|^cmr|^cmbx|^cmti|^cmsl|^cmcsc|^cmu|lmroman|nimbusrom|termes|pagella|utopia|bookman|century|schoolbook|sabon|perpetua|goudy|bembo|plantin|janson|stix|cardo|gentium|sylfaen|minion|tiempos|freeserif)/;
const MONO = /(courier|mono|consol|menlo|monaco|inconsolata|code|cousine|^cmtt|nimbusmon|cursor)/;

/** Family/style descriptors derived from a PostScript name. */
export const describeFont = (baseFont: string) => {
    const raw = baseFont.replace(/^[A-Z]{6}\+/, "");
    const s = raw.toLowerCase().replace(/\s/g, "");
    const weight = weightOf(raw);
    const bold = weight >= 600;
    const italic = /italic|oblique/.test(s);
    const mono = MONO.test(s);
    const sans = SANS.test(s);
    const serif = !mono && !sans && SERIF.test(s);
    const family = (raw.split(/[-,]/)[0] ?? raw)
        .toLowerCase()
        .replace(/\s/g, "")
        .replace(/(psmt|mt|ps)$/, "");
    return { family, weight, bold, italic, mono, serif };
};

export const slugFamily = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
