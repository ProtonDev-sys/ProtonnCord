/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Paragraph } from "@components/Paragraph";
import { findComponentByCodeLazy } from "@webpack";
import { useEffect, useRef, useState } from "@webpack/common";

import { Canvas } from "./components/Canvas";
import { Toolbar } from "./components/Toolbar";
import { imageToBlob, urlToImage } from "./utils/canvas";

const FileUpload = findComponentByCodeLazy(".currentTarget.files", "lineClamp:1");

interface EditorProps {
    url?: string;
}

export const Editor = ({ url }: EditorProps) => {
    const [file, setFile] = useState<File>();
    const [ready, setReady] = useState(false);
    const [error, setError] = useState<string>();
    const load = useRef<AbortController | null>(null);

    useEffect(() => {
        if (!url) return;
        const controller = new AbortController();
        load.current = controller;
        setFile(undefined);
        setReady(false);
        setError(undefined);
        void urlToImage(url, controller.signal).then(imageToBlob).then(nextFile => {
            if (!controller.signal.aborted) setFile(nextFile);
        }).catch(() => {
            if (!controller.signal.aborted) setError("Could not load the image. Choose a file to retry.");
        });
        return () => {
            controller.abort();
            if (load.current === controller) load.current = null;
        };
    }, [url]);

    function selectFile(nextFile: File) {
        load.current?.abort();
        setReady(false);
        setError(undefined);
        setFile(nextFile);
    }

    return (
        <div className="vc-remix-editor">
            {!file || error ? <FileUpload
                filename={undefined}
                placeholder="Choose an image"
                buttonText="Browse"
                filters={[{ name: "Image", extensions: ["png", "jpeg"] }]}
                onFileSelect={selectFile}
            /> : null}
            {error ? <Paragraph>{error}</Paragraph> : null}
            {ready ? <Toolbar /> : null}
            {file ? <Canvas file={file} onReady={setReady} onError={setError} /> : null}
        </div>
    );
};
