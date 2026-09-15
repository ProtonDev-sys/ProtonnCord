/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BaseText } from "@components/BaseText";
import { Button, TextButton } from "@components/Button";
import loginWithQR from "@equicordplugins/loginWithQR";
import { images } from "@equicordplugins/loginWithQR/images";
import { getIntlMessage } from "@utils/discord";
import { RenderModalProps } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import {
    Modal,
    openModal,
    RestAPI,
    useEffect,
    useRef,
    useState } from "@webpack/common";

import { cl } from "..";

const { Controller } = findByPropsLazy("Controller");

enum VerifyState {
    Verifying,
    LoggedIn,
    NotFound,
}

function VerifyModal({
    token,
    onAbort,
    ...props
}: {
    token: string | null;
    onAbort: () => void;
} & RenderModalProps) {
    const [state, setState] = useState(
        !token ? VerifyState.NotFound : VerifyState.Verifying
    );
    const [inProgress, setInProgress] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const [controllerRef] = useState(() => new Controller({ progress: "0%" }));
    const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const mounted = useRef(true);
    const finished = useRef(false);
    const submitting = useRef(false);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            clearTimeout(timeoutRef.current);
            controllerRef.stop();
            if (!finished.current) onAbort();
        };
    }, []);

    const holdDuration = 1000;
    const startInput = () => {
        if (!buttonRef.current || !mounted.current || !loginWithQR.started || submitting.current || state !== VerifyState.Verifying) return;
        clearTimeout(timeoutRef.current);

        controllerRef.start({
            progress: "100%",
            config: {
                duration: holdDuration,
                // https://easings.net/#easeInOutSine
                easing: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
            },
        });
        timeoutRef.current = setTimeout(() => {
            timeoutRef.current = undefined;
            if (!mounted.current || !loginWithQR.started || submitting.current || state !== VerifyState.Verifying) return;

            submitting.current = true;
            setInProgress(true);
            RestAPI.post({
                url: "/users/@me/remote-auth/finish",
                body: {
                    handshake_token: token,
                },
            })
                .then(() => {
                    if (!mounted.current) return;
                    finished.current = true;
                    setState(VerifyState.LoggedIn);
                })
                .catch(() => { if (mounted.current) setState(VerifyState.NotFound); })
                .finally(() => {
                    submitting.current = false;
                    if (mounted.current) setInProgress(false);
                });
        }, holdDuration + 250);
    };

    const endInput = () => {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = undefined;
        if (!buttonRef.current) return;

        controllerRef.start({
            progress: "0%",
            config: {
                duration: 696,
                // https://easings.net/#easeOutCubic
                easing: (t: number) => 1 - Math.pow(1 - t, 3),
            },
        });
    };

    useEffect(() => {
        let frame: number;
        const update = () => {
            buttonRef.current?.style.setProperty(
                "--progress",
                controllerRef.get().progress
            );

            frame = requestAnimationFrame(update);
        };

        if (state === VerifyState.Verifying) frame = requestAnimationFrame(update);
        return () => cancelAnimationFrame(frame);
    }, [state]);

    return (
        <Modal size="sm" {...props} title="Verify Login">
            <div className={cl("device-content")}>
                {state === VerifyState.LoggedIn ? (
                    <>
                        <img
                            className={cl("device-image")}
                            src={images.deviceImage.success}
                            key="img-success"
                            draggable={false}
                        />
                        <BaseText
                            size="xl"
                            weight="bold"
                            color="text-strong"
                            tag="h1"
                            className={cl("device-header")}
                        >
                            {getIntlMessage("QR_CODE_LOGIN_SUCCESS")}
                        </BaseText>
                        <BaseText
                            size="md"
                            weight="semibold"
                            color="text-default"
                            style={{ width: "30rem", textAlign: "center" }}
                        >
                            {getIntlMessage("QR_CODE_LOGIN_SUCCESS_FLAVOR")}
                        </BaseText>
                    </>
                ) : state === VerifyState.NotFound ? (
                    <>
                        <img
                            className={cl("device-image")}
                            src={images.deviceImage.notFound}
                            key="img-not_found"
                            draggable={false}
                        />
                        <BaseText
                            size="xl"
                            weight="bold"
                            color="text-strong"
                            tag="h1"
                            className={cl("device-header")}
                        >
                            {getIntlMessage("QR_CODE_NOT_FOUND")}
                        </BaseText>
                        <BaseText
                            size="md"
                            weight="semibold"
                            color="text-default"
                            style={{ width: "30rem" }}
                        >
                            {getIntlMessage("QR_CODE_NOT_FOUND_DESCRIPTION")}
                        </BaseText>
                    </>
                ) : (
                    <>
                        <img
                            className={cl("device-image")}
                            src={images.deviceImage.loading}
                            key="img-loaded"
                            draggable={false}
                        />
                        <BaseText
                            size="xl"
                            weight="bold"
                            color="text-strong"
                            tag="h1"
                            className={cl("device-header")}
                        >
                            {getIntlMessage("QR_CODE_LOGIN_CONFIRM")}
                        </BaseText>
                        <BaseText size="md" weight="semibold" color="text-danger">
                            Never scan a login QR code from another user or application.
                        </BaseText>
                        <Button
                            size="medium"
                            variant="dangerPrimary"
                            className={cl("device-confirm")}
                            style={{
                                ["--progress" as any]: `${holdDuration}ms`,
                            }}
                            onPointerDown={startInput}
                            onPointerUp={endInput}
                            onPointerCancel={endInput}
                            onPointerLeave={endInput}
                            onBlur={endInput}
                            ref={buttonRef}
                            disabled={inProgress}
                        >
                            Hold to confirm login
                        </Button>
                    </>
                )}
            </div>
            <div className={cl("device-footer")} style={{ marginTop: "20px", display: "flex", justifyContent: "flex-end", gap: "10px" }}>
                {state === VerifyState.LoggedIn ? (
                    <Button onClick={props.onClose}>
                        {getIntlMessage("QR_CODE_LOGIN_FINISH_BUTTON")}
                    </Button>
                ) : (
                    <TextButton
                        variant="link"
                        onClick={props.onClose}
                    >
                        {state === VerifyState.NotFound
                            ? getIntlMessage("CLOSE")
                            : getIntlMessage("CANCEL")}
                    </TextButton>
                )}
            </div>
        </Modal>
    );
}

export default function openVerifyModal(
    token: string | null,
    onAbort: () => void,
) {
    return openModal(props => (
        <VerifyModal
            {...props}
            token={token}
            onAbort={onAbort}
        />
    ));
}
