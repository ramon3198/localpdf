"use client";

import { useEffect, useRef } from "react";

/**
 * Files dropped or pasted anywhere on the page go to whatever is ready to take them: a tool's drop zone, a list that
 * accepts more files, or the home page. Each of those registers itself while it is on screen; the app shell hands the
 * files to the one registered last.
 */

type Receiver = (files: File[]) => void;

const receivers: Receiver[] = [];

/** Is anything on screen ready to take files? */
export const hasFileReceiver = () => receivers.length > 0;

/** Hands `files` to the current receiver. False when nothing took them. */
export const deliverFiles = (files: File[]) => {
    const receive = receivers[receivers.length - 1];
    if (!receive || !files.length) return false;
    receive(files);
    return true;
};

/** Takes the files dropped or pasted outside any drop zone while the component is on screen and `enabled`. */
export const useFileReceiver = (receive: Receiver, enabled = true) => {
    const latest = useRef(receive);
    latest.current = receive;
    useEffect(() => {
        if (!enabled) return;
        const receiver: Receiver = (files) => latest.current(files);
        receivers.push(receiver);
        return () => {
            const index = receivers.indexOf(receiver);
            if (index >= 0) receivers.splice(index, 1);
        };
    }, [enabled]);
};
