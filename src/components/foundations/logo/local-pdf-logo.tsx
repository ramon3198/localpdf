import type { HTMLAttributes } from "react";
import { cx } from "@/utils/cx";

export const LocalPdfLogo = (props: HTMLAttributes<HTMLOrSVGElement>) => {
    return (
        <div {...props} className={cx("flex h-8 w-max items-center gap-2", props.className)}>
            <LocalPdfMark className="aspect-square h-full w-auto shrink-0" />
            <span className="text-md font-semibold tracking-tight text-primary">
                Local<span className="text-fg-brand-primary">PDF</span>
            </span>
        </div>
    );
};

export const LocalPdfMark = (props: HTMLAttributes<HTMLOrSVGElement>) => {
    return (
        <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
            <rect width="32" height="32" rx="8" className="fill-fg-brand-primary" />
            <path
                d="M9 8.5C9 8.22386 9.22386 8 9.5 8H17.5L23 13.5V23.5C23 23.7761 22.7761 24 22.5 24H9.5C9.22386 24 9 23.7761 9 23.5V8.5Z"
                fill="white"
            />
            <path d="M17 8L23 14H17.5C17.2239 14 17 13.7761 17 13.5V8Z" className="fill-fg-brand-primary opacity-40" />
            <path
                d="M11.5 17.5H13.2C13.9732 17.5 14.6 18.1268 14.6 18.9C14.6 19.6732 13.9732 20.3 13.2 20.3H12.4V21.5H11.5V17.5Z"
                className="fill-fg-brand-primary"
            />
            <path
                d="M15.4 17.5H16.9C18.1703 17.5 19.2 18.4297 19.2 19.5C19.2 20.5703 18.1703 21.5 16.9 21.5H15.4V17.5ZM16.3 18.3V20.7H16.85C17.6232 20.7 18.3 20.2284 18.3 19.5C18.3 18.7716 17.6232 18.3 16.85 18.3H16.3Z"
                className="fill-fg-brand-primary"
            />
            <path d="M20 17.5H22V18.3H20.9V19.1H21.9V19.9H20.9V21.5H20V17.5Z" className="fill-fg-brand-primary" />
        </svg>
    );
};
