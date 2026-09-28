/** @type {import('next').NextConfig} */
const nextConfig = {
    // `npm run build:static` (used by netlify.toml) builds a plain static site in out/: every tool runs in the browser.
    // npm names the running script in npm_lifecycle_event, which works the same in every shell.
    output: process.env.npm_lifecycle_event === "build:static" || process.env.STATIC_EXPORT === "1" ? "export" : undefined,
    // The dev-only Next.js badge covers the sticky action bars on phones; build errors still show in the overlay.
    devIndicators: false,
    experimental: {
        optimizePackageImports: ["@untitledui/icons"],
    },
};

export default nextConfig;
