/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Flex } from "@components/Flex";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { classes } from "@utils/misc";
import { RenderModalProps } from "@vencord/discord-types";
import { Button, FluxDispatcher, Modal, openModal, TextInput, useCallback, useRef, useState } from "@webpack/common";

import { settings } from "../settings";
import { Collection, Gif } from "../types";
import { cache_collections, createCollection, getItemCollectionNameFromId, moveGifToCollection, renameCollection } from "../utils/collectionManager";
import { cl, stripPrefix } from "../utils/misc";

export function openCollectionInfoModal(collection: Collection) {
    openModal(props => (
        <InfoModal props={props} title="Collection Information" rows={[
            { label: "Name", value: stripPrefix(collection.name) },
            { label: "Gifs", value: String(collection.gifs.length) },
            { label: "Created At", value: collection.createdAt ? new Date(collection.createdAt).toLocaleString() : "Unknown" },
            { label: "Last Updated", value: collection.lastUpdated ? new Date(collection.lastUpdated).toLocaleString() : "Unknown" },
        ]} />
    ));
}

export function openGifInfoModal(gif: Gif) {
    openModal(props => (
        <InfoModal props={props} title="Information" rows={[
            { label: "Added At", value: gif.addedAt ? new Date(gif.addedAt).toLocaleString() : "Unknown" },
            { label: "Width", value: String(gif.width) },
            { label: "Height", value: String(gif.height) },
        ]} />
    ));
}

export function openMoveToCollectionModal(gifId: string) {
    openModal(props => <MoveToCollectionModal props={props} gifId={gifId} />);
}

export function openCreateCollectionModal(gif: Gif) {
    openModal(props => <CreateCollectionModal props={props} gif={gif} />);
}

export function openRenameCollectionModal(name: string) {
    openModal(props => <RenameCollectionModal props={props} name={name} />);
}

function InfoModal({ props, title, rows }: { props: RenderModalProps; title: string; rows: { label: string; value: string; }[]; }) {
    return (
        <Modal
            {...props}
            size="sm"
            title={title}
            actions={[
                { text: "Close", variant: "secondary", onClick: props.onClose }
            ]}
        >
            <section>
                {rows.map(row => (
                    <Flex key={row.label} className={cl("info-row")}>
                        <Heading className={cl("info-title")}>{row.label}</Heading>
                        <Paragraph className={cl("info-text")}>{row.value}</Paragraph>
                    </Flex>
                ))}
            </section>
        </Modal>
    );
}

function MoveToCollectionModal({ props, gifId }: { props: RenderModalProps; gifId: string; }) {
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const submitting = useRef(false);
    return (
        <Modal
            {...props}
            size="sm"
            title="Move To Collection"
            actions={[
                { text: "Close", variant: "secondary", onClick: props.onClose }
            ]}
        >
            <Heading style={{ marginBottom: "10px" }}>Select a collection to move the item to</Heading>
            {error && <Paragraph role="alert">{error}</Paragraph>}
            <div className={cl("buttons")}>
                {cache_collections
                    .filter(col => col.name !== getItemCollectionNameFromId(gifId))
                    .map(col => (
                        <Button
                            key={col.name}
                            disabled={busy}
                            className={cl("button")}
                            onClick={async () => {
                                if (submitting.current) return;
                                const fromCollection = getItemCollectionNameFromId(gifId);
                                if (!fromCollection) return;
                                submitting.current = true;
                                setBusy(true);
                                setError("");
                                try {
                                    await moveGifToCollection(gifId, fromCollection, col.name);
                                    FluxDispatcher.dispatch({ type: "GIF_PICKER_QUERY", query: "" });
                                    FluxDispatcher.dispatch({ type: "GIF_PICKER_QUERY", query: fromCollection });
                                    props.onClose();
                                } catch (error) {
                                    setError(error instanceof Error ? error.message : "Could not move this GIF. Please try again.");
                                } finally {
                                    submitting.current = false;
                                    setBusy(false);
                                }
                            }}
                        >
                            {stripPrefix(col.name)}
                        </Button>
                    ))}
            </div>
        </Modal>
    );
}

function CreateCollectionModal({ props, gif }: { props: RenderModalProps; gif: Gif; }) {
    const [name, setName] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const submitting = useRef(false);
    const onSubmit = useCallback(async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!name.length || submitting.current) return;
        submitting.current = true;
        setBusy(true);
        setError("");
        try {
            await createCollection(name, [gif]);
            props.onClose();
        } catch (error) {
            setError(error instanceof Error ? error.message : "Could not save this collection. Please try again.");
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }, [name, gif, props]);

    return (
        <Modal
            {...props}
            size="sm"
            title="Create Collection"
            actions={[
                { text: "Create", onClick: onSubmit, disabled: !name.length || busy, variant: "primary" }
            ]}
        >
            <form onSubmit={onSubmit}>
                <Heading className={cl("rename-text")}>Collection Name</Heading>
                <TextInput value={name} onChange={setName} disabled={busy} />
                {error && <Paragraph role="alert">{error}</Paragraph>}
            </form>
        </Modal>
    );
}

function RenameCollectionModal({ props, name }: { props: RenderModalProps; name: string; }) {
    const prefix = settings.store.collectionPrefix;
    const strippedName = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    const [newName, setNewName] = useState(strippedName);
    const tooLong = newName.length >= 25;
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const submitting = useRef(false);

    const onSubmit = useCallback(async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!newName.length || tooLong || submitting.current) return;
        submitting.current = true;
        setBusy(true);
        setError("");
        try {
            await renameCollection(name, newName);
            props.onClose();
        } catch (error) {
            setError(error instanceof Error ? error.message : "Could not rename this collection. Please try again.");
        } finally {
            submitting.current = false;
            setBusy(false);
        }
    }, [newName, name, tooLong, props]);

    return (
        <Modal
            {...props}
            size="sm"
            title="Rename Collection"
            actions={[
                { text: "Rename", onClick: onSubmit, disabled: !newName.length || tooLong || busy, variant: "primary" }
            ]}
        >
            <form onSubmit={onSubmit}>
                <Paragraph className={cl("rename-text")}>New Collection Name</Paragraph>
                <TextInput value={newName} disabled={busy} className={classes(cl("rename-input"), tooLong ? cl("input-warning") : "")} onChange={setNewName} />
                {error && <Paragraph role="alert">{error}</Paragraph>}
                {tooLong && <Paragraph className={cl("warning-text")}>Name can't be longer than 24 characters</Paragraph>}
            </form>
        </Modal>
    );
}
