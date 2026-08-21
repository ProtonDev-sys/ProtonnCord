/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Protonn Cord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton, type ChatBarButtonFactory } from "@api/ChatButtons";
import { addMessageAccessory, type MessageAccessoryFactory, removeMessageAccessory } from "@api/MessageAccessories";
import { plugins } from "@api/PluginManager";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Heading } from "@components/Heading";
import { copyToClipboard } from "@utils/clipboard";
import { EquicordDevs } from "@utils/constants";
import { sendMessage } from "@utils/discord";
import { classes } from "@utils/misc";
import definePlugin, { type PluginNative } from "@utils/types";
import type { Channel, Message, RenderModalProps } from "@vencord/discord-types";
import {
    Checkbox,
    MessageStore,
    Modal,
    openModal,
    showToast,
    TextArea,
    Toasts,
    useCallback,
    useEffect,
    UserStore,
    useState,
    useStateFromStores,
} from "@webpack/common";

import { decryptCachedMessage, decryptCacheKey } from "../secureMessaging.desktop/decryptCache";
import { discordEditedTimestamp } from "../secureMessaging.desktop/messageMetadata";
import type {
    AnnouncementReviewResult,
    NativeFailure,
} from "../secureMessaging.desktop/native";
import { isEncryptedMessage } from "../secureMessaging.desktop/protocol";
import type {
    SecurityKeyFailure,
    SecurityKeyProfileSummary,
    SecurityKeyProofReviewResult,
    SecurityKeyRootSummary,
    SecurityKeyStateResult,
} from "./native";
import {
    formatSecurityKeyFingerprint,
    isSecurityKeyProof,
    parseSecurityKeyProof,
    type SecurityKeyProof,
    serializeSecurityKeyProof,
} from "./protocol";

const Native = VencordNative.pluginHelpers.SecureMessagingSecurityKey as PluginNative<typeof import("./native")>;
const SecureNative = VencordNative.pluginHelpers.SecureMessaging as PluginNative<typeof import("../secureMessaging.desktop/native")>;

interface SecureMessagingRuntime {
    getScreenCaptureProtectionStatus?(): string;
    started?: boolean;
}

interface ProofReviewState {
    announcement: AnnouncementReviewResult | null;
    security: SecurityKeyProofReviewResult;
}

function secureMessagingRuntime(): SecureMessagingRuntime | undefined {
    return (plugins as unknown as Record<string, SecureMessagingRuntime>).SecureMessaging;
}

function isSecurityKeyFailure(result: { status: string; }): result is SecurityKeyFailure {
    return result.status === "invalid_input" || result.status === "unavailable" || result.status === "failed";
}

function isCoreFailure(result: { status: string; }): result is NativeFailure {
    return result.status === "invalid_input" || result.status === "unavailable" || result.status === "failed";
}

function securityKeyFailureMessage(result: SecurityKeyFailure): string {
    if (result.status === "invalid_input") return result.error;
    if (result.status === "unavailable") {
        if (result.reason === "unsafe_linux_backend")
            return "Hardware identity refuses Linux's unencrypted basic_text secure-storage backend.";
        if (result.reason === "secure_storage_unavailable")
            return "Your operating system's secure key storage is unavailable.";
        return "This Discord/Electron build cannot open an isolated WebAuthn security-key window.";
    }
    if (result.error === "ceremony_cancelled") return "The security-key operation was cancelled or timed out.";
    if (result.error === "credential_mismatch") return "A different key answered, or the authenticator counter moved backwards.";
    if (result.error === "capacity_exceeded") return "The hardware-identity store reached its safety limit.";
    if (result.error === "storage_error") return "The encrypted hardware-identity store could not be saved.";
    return "The security-key assertion failed authentication.";
}

function coreFailureMessage(result: NativeFailure): string {
    if (result.status === "invalid_input") return result.error;
    if (result.status === "unavailable") return "Secure Messaging key storage is unavailable.";
    return "The Secure Messaging identity operation failed.";
}

function userLabel(userId: string): string {
    const user = UserStore.getUser(userId) as { globalName?: string; global_name?: string; username?: string; } | undefined;
    return user?.globalName || user?.global_name || user?.username || userId;
}

function HardwareKeyIcon({ color }: Record<string, any>) {
    return (
        <svg aria-hidden role="img" width="20" height="20" viewBox="0 0 24 24" style={{ color }}>
            <path
                fill="currentColor"
                d="M7.5 3a5.5 5.5 0 1 0 4.98 7.84L21 19.36V22h-2.64l-1.5-1.5-1.5 1.5-2.12-2.12 1.5-1.5-1.41-1.42-1.5 1.5-2.18-2.18 1.52-1.52-1.07-1.07A5.5 5.5 0 0 0 7.5 3Zm0 3A2.5 2.5 0 1 1 5 8.5 2.5 2.5 0 0 1 7.5 6Z"
            />
        </svg>
    );
}

function profileAlgorithmLabel(algorithm: number): string {
    if (algorithm === -7) return "ES256";
    if (algorithm === -8) return "Ed25519";
    if (algorithm === -257) return "RS256";
    return String(algorithm);
}

function ProfileBlock({ profile }: { profile: SecurityKeyProfileSummary; }) {
    return (
        <>
            <code className="pc-security-key-fingerprint">{profile.formattedRootFingerprint}</code>
            <BaseText size="xs" color="text-muted">
                FIDO2/WebAuthn root • {profileAlgorithmLabel(profile.algorithm)}
                {profile.transports.length > 0 ? ` • ${profile.transports.join(", ")}` : ""}
            </BaseText>
        </>
    );
}

interface SecurityKeyManagerProps {
    channel: Channel;
    modalProps: RenderModalProps;
}

function SecurityKeyManager({ channel, modalProps }: SecurityKeyManagerProps) {
    const localUserId = UserStore.getCurrentUser()?.id;
    const [state, setState] = useState<SecurityKeyStateResult | null>(null);
    const [importText, setImportText] = useState("");
    const [busy, setBusy] = useState(false);
    const [confirmUnlink, setConfirmUnlink] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        if (!localUserId) return;
        setError(null);
        const next = await Native.getSecurityKeyState(localUserId);
        setState(next);
        if (isSecurityKeyFailure(next)) setError(securityKeyFailureMessage(next));
    }, [localUserId]);

    useEffect(() => { void load(); }, [load]);

    const run = async (operation: () => Promise<unknown>) => {
        setBusy(true);
        setError(null);
        try {
            await operation();
        } catch {
            setError("The hardware-identity operation failed unexpectedly.");
        } finally {
            setBusy(false);
        }
    };

    const setup = () => run(async () => {
        if (!localUserId) return;
        const result = await Native.setupSecurityKey(localUserId);
        if (result.status !== "configured") {
            setError(securityKeyFailureMessage(result));
            return;
        }
        showToast("Hardware identity configured for this Discord account.", Toasts.Type.SUCCESS);
        await load();
    });

    const importProfile = () => run(async () => {
        if (!localUserId) return;
        const result = await Native.importSecurityKeyProfile(localUserId, importText);
        if (result.status !== "configured") {
            setError(securityKeyFailureMessage(result));
            return;
        }
        setImportText("");
        showToast("Existing hardware identity linked to this account.", Toasts.Type.SUCCESS);
        await load();
    });

    const linkKnown = (fingerprint: string) => run(async () => {
        if (!localUserId) return;
        const result = await Native.linkKnownSecurityKey(localUserId, fingerprint);
        if (result.status !== "configured") {
            setError(securityKeyFailureMessage(result));
            return;
        }
        showToast("Local hardware identity linked to this account.", Toasts.Type.SUCCESS);
        await load();
    });

    const unlink = () => run(async () => {
        if (!localUserId || !confirmUnlink) return;
        const result = await Native.unlinkSecurityKey(localUserId);
        if (result.status !== "unlinked") {
            setError(securityKeyFailureMessage(result));
            return;
        }
        setConfirmUnlink(false);
        showToast("This account was unlinked from the local hardware identity.", Toasts.Type.SUCCESS);
        await load();
    });

    const shareProof = () => run(async () => {
        if (!localUserId) return;
        const announcement = await SecureNative.createAnnouncement(localUserId);
        if (announcement.status !== "created") {
            setError(coreFailureMessage(announcement));
            return;
        }
        const proof = await Native.createSecurityKeyProof(localUserId, announcement.content);
        if (proof.status !== "created") {
            setError(securityKeyFailureMessage(proof));
            return;
        }
        await sendMessage(channel.id, { content: proof.content });
        showToast(
            "Hardware identity proof sent. It is encrypted automatically when this conversation is protected.",
            Toasts.Type.SUCCESS,
        );
        modalProps.onClose();
    });

    const activeProfile = state?.status === "ready" ? state.activeProfile : null;
    const availableProfiles = state?.status === "ready" ? state.availableProfiles : [];

    return (
        <Modal {...modalProps} size="medium" title="Secure Messaging hardware identity">
            <div className="pc-security-key-modal">
                <BaseText size="sm">
                    A roaming FIDO2 security key can anchor your Secure Messaging identity across computers and Discord accounts. The key proves continuity; message-encryption private keys remain separate and OS-protected on each computer.
                </BaseText>

                {!state && <BaseText size="sm">Loading encrypted hardware-identity state…</BaseText>}

                {activeProfile ? (
                    <>
                        <section className="pc-security-key-section">
                            <Heading tag="h5">Current hardware identity</Heading>
                            <ProfileBlock profile={activeProfile} />
                            <div className="pc-security-key-actions">
                                <Button
                                    size="small"
                                    onClick={() => {
                                        copyToClipboard(activeProfile.exportText);
                                        showToast("Public security-key profile copied.", Toasts.Type.SUCCESS);
                                    }}
                                >
                                    Copy public profile
                                </Button>
                                <Button size="small" variant="primary" disabled={busy} onClick={() => void shareProof()}>
                                    Share verified identity in this chat
                                </Button>
                            </div>
                            <BaseText size="xs" color="text-muted">
                                The exported profile contains only the public key and its credential identifier. Linking it elsewhere still requires this physical key and its PIN or biometric check.
                            </BaseText>
                        </section>

                        <section className="pc-security-key-section">
                            <Heading tag="h5">Unlink this account</Heading>
                            <Checkbox
                                value={confirmUnlink}
                                disabled={busy}
                                onChange={(_event, checked) => setConfirmUnlink(checked)}
                                size={20}
                            >
                                <BaseText size="xs">
                                    I understand that future device or account keys will no longer carry this hardware continuity proof until I link it again.
                                </BaseText>
                            </Checkbox>
                            <Button size="small" variant="dangerPrimary" disabled={!confirmUnlink || busy} onClick={() => void unlink()}>
                                Unlink hardware identity
                            </Button>
                        </section>
                    </>
                ) : state?.status === "ready" ? (
                    <>
                        <section className="pc-security-key-section">
                            <Heading tag="h5">Set up a new security key</Heading>
                            <BaseText size="xs" color="text-muted">
                                ProtonnCord requires a roaming authenticator with user verification. Touch-only U2F keys without a PIN or biometric capability are rejected.
                            </BaseText>
                            <Button size="small" variant="primary" disabled={busy} onClick={() => void setup()}>
                                Set up hardware security key
                            </Button>
                        </section>

                        {availableProfiles.length > 0 && (
                            <section className="pc-security-key-section">
                                <Heading tag="h5">Link a key already known on this computer</Heading>
                                {availableProfiles.map(profile => (
                                    <div key={profile.rootFingerprint}>
                                        <ProfileBlock profile={profile} />
                                        <Button size="small" disabled={busy} onClick={() => void linkKnown(profile.rootFingerprint)}>
                                            Link current Discord account
                                        </Button>
                                    </div>
                                ))}
                            </section>
                        )}

                        <section className="pc-security-key-section">
                            <Heading tag="h5">Link an exported profile from another computer</Heading>
                            <TextArea
                                autosize
                                value={importText}
                                onChange={setImportText}
                                placeholder="PCSKP1:…"
                                disabled={busy}
                            />
                            <Button size="small" disabled={busy || !importText.trim()} onClick={() => void importProfile()}>
                                Verify physical key and link account
                            </Button>
                        </section>
                    </>
                ) : null}

                <section className="pc-security-key-section">
                    <Heading tag="h5">Security properties</Heading>
                    <BaseText size="xs" color="text-muted">
                        Proofs bind the current Discord account and current Secure Messaging public keys to the hardware root. Recipients can recognize the same root on a new computer or another explicitly linked account. ProtonnCord never uploads a security-key credential identifier in chat, and the hardware key never receives message plaintext or decryption keys. Losing the key does not erase local messages, but contacts must verify a replacement root.
                    </BaseText>
                </section>

                {busy && <BaseText size="xs" color="text-muted">Waiting for the security key…</BaseText>}
                {error && <BaseText size="sm" className="pc-secure-status-danger">{error}</BaseText>}
            </div>
        </Modal>
    );
}

function openSecurityKeyManager(channel: Channel): void {
    openModal(modalProps => <SecurityKeyManager channel={channel} modalProps={modalProps} />);
}

const SecurityKeyButton: ChatBarButtonFactory = ({ channel, isMainChat }) => {
    if (!isMainChat || !channel || (!channel.isDM?.() && !channel.isGroupDM?.() && !channel.isMultiUserDM?.()) ||
        secureMessagingRuntime()?.started !== true) return null;
    return (
        <ChatBarButton
            tooltip="Secure Messaging hardware identity"
            onClick={() => openSecurityKeyManager(channel)}
            buttonProps={{ "aria-haspopup": "dialog" }}
        >
            <HardwareKeyIcon />
        </ChatBarButton>
    );
};

interface TrustProofModalProps {
    announcementReview: AnnouncementReviewResult;
    message: Message;
    modalProps: RenderModalProps;
    onComplete(): void;
    securityReview: Exclude<SecurityKeyProofReviewResult,
        SecurityKeyFailure | { status: "invalid_proof" | "replay_detected"; } | { status: "trusted"; }>;
}

async function trustEncryptionAnnouncement(
    localUserId: string,
    peerUserId: string,
    message: Message,
    announcement: string,
    initialReview: AnnouncementReviewResult,
): Promise<boolean> {
    let review = initialReview;
    if (review.status === "trusted") return true;
    if (review.status === "key_changed") {
        const forgotten = await SecureNative.forgetPeer(localUserId, peerUserId);
        if (forgotten.status !== "forgotten" && forgotten.status !== "not_found")
            throw new Error(coreFailureMessage(forgotten));
        review = await SecureNative.reviewAnnouncement(
            localUserId,
            peerUserId,
            announcement,
            message.id,
            discordEditedTimestamp(message),
        );
    }
    if (review.status === "trusted") return true;
    if (review.status !== "trust_required") {
        if (isCoreFailure(review)) throw new Error(coreFailureMessage(review));
        throw new Error(review.status === "stale_announcement"
            ? "The embedded encryption-key announcement is older than the currently trusted key."
            : "The embedded encryption-key announcement cannot be trusted.");
    }
    const trusted = await SecureNative.trustReviewedKey(
        localUserId,
        peerUserId,
        review.reviewToken,
        review.identity.fingerprint,
    );
    if (trusted.status === "trusted" || trusted.status === "already_trusted") return true;
    if (isCoreFailure(trusted)) throw new Error(coreFailureMessage(trusted));
    throw new Error("The encryption key changed before it could be trusted.");
}

function TrustProofModal({ announcementReview, message, modalProps, onComplete, securityReview }: TrustProofModalProps) {
    const localUserId = UserStore.getCurrentUser()?.id;
    const peerUserId = message.author.id;
    const replacingRoot = securityReview.status === "key_changed";
    const [confirmed, setConfirmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const trust = async () => {
        if (!localUserId || !confirmed) return;
        setBusy(true);
        setError(null);
        try {
            const root = await Native.trustSecurityKeyProof(
                localUserId,
                peerUserId,
                securityReview.reviewToken,
                securityReview.root.rootFingerprint,
                replacingRoot,
            );
            if (root.status !== "trusted") {
                if (isSecurityKeyFailure(root))
                    setError(securityKeyFailureMessage(root));
                else if (root.status === "key_changed")
                    setError("A different hardware root is already associated with this Discord account.");
                else
                    setError("The hardware proof review expired. Close this window and review the message again.");
                return;
            }
            await trustEncryptionAnnouncement(
                localUserId,
                peerUserId,
                message,
                securityReview.announcement,
                announcementReview,
            );
            showToast(
                replacingRoot
                    ? "Hardware identity and encryption key replaced. Re-enable affected protected conversations after reviewing participants."
                    : "Discord account and encryption key verified through the hardware security key.",
                Toasts.Type.SUCCESS,
            );
            MessageStore.emitChange();
            onComplete();
            modalProps.onClose();
        } catch (operationError) {
            setError(operationError instanceof Error ? operationError.message : "The hardware identity was not trusted.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            {...modalProps}
            size="sm"
            title={replacingRoot ? "Replace hardware identity" : "Verify hardware identity"}
            actions={[
                { text: "Cancel", variant: "secondary", onClick: modalProps.onClose, disabled: busy },
                {
                    text: replacingRoot ? "Replace identity" : "Trust identity",
                    variant: replacingRoot ? "dangerPrimary" : "primary",
                    onClick: () => void trust(),
                    disabled: !confirmed || busy,
                },
            ]}
        >
            <div className="pc-security-key-modal">
                <BaseText size="sm">
                    {replacingRoot
                        ? "This account was previously associated with a different hardware root. Replace it only after confirming the change with the person through another trusted channel."
                        : securityReview.status === "linked"
                            ? "This proof matches a hardware root you already trust for another Discord account. Confirm that this additional account belongs to the same person."
                            : "Compare this hardware-root fingerprint with the person through a trusted channel outside this Discord conversation."}
                </BaseText>
                <code className="pc-security-key-fingerprint">{securityReview.root.formattedRootFingerprint}</code>
                {securityReview.root.linkedUserIds.length > 0 && (
                    <BaseText size="xs" color="text-muted">
                        Already linked: {securityReview.root.linkedUserIds.map(userLabel).join(", ")}
                    </BaseText>
                )}
                <Checkbox
                    value={confirmed}
                    disabled={busy}
                    onChange={(_event, checked) => setConfirmed(checked)}
                    size={20}
                >
                    <BaseText size="sm">
                        {replacingRoot
                            ? "I independently confirmed that this person intentionally replaced their hardware security key."
                            : "I recognize this hardware identity and want to trust the bound Secure Messaging encryption key."}
                    </BaseText>
                </Checkbox>
                {error && <BaseText size="sm" className="pc-secure-status-danger">{error}</BaseText>}
            </div>
        </Modal>
    );
}

function validSecurityReview(result: SecurityKeyProofReviewResult): result is Exclude<SecurityKeyProofReviewResult,
    SecurityKeyFailure | { status: "invalid_proof" | "replay_detected"; }> {
    return !isSecurityKeyFailure(result) && result.status !== "invalid_proof" && result.status !== "replay_detected";
}

function RootDetails({ root }: { root: SecurityKeyRootSummary; }) {
    return (
        <>
            <code className="pc-security-key-fingerprint">{root.formattedRootFingerprint}</code>
            {root.linkedUserIds.length > 0 && (
                <div className="pc-security-key-linked-users">
                    Trusted accounts on this hardware root: {root.linkedUserIds.map(userLabel).join(", ")}
                </div>
            )}
        </>
    );
}

function ProofCard({ message, proof }: { message: Message; proof: SecurityKeyProof; }) {
    const localUserId = UserStore.getCurrentUser()?.id;
    const ownProof = message.author.id === localUserId;
    const [revision, setRevision] = useState(0);
    const [review, setReview] = useState<ProofReviewState | null>(null);

    useEffect(() => {
        let active = true;
        setReview(null);
        if (!localUserId || ownProof) return () => { active = false; };
        void Native.reviewSecurityKeyProof(
            localUserId,
            message.author.id,
            serializeSecurityKeyProof(proof),
            message.id,
            discordEditedTimestamp(message),
        ).then(async security => {
            if (!active) return;
            if (!validSecurityReview(security)) {
                setReview({ announcement: null, security });
                return;
            }
            const announcement = await SecureNative.reviewAnnouncement(
                localUserId,
                message.author.id,
                security.announcement,
                message.id,
                discordEditedTimestamp(message),
            );
            if (active) setReview({ announcement, security });
        }).catch(() => {
            if (active) setReview({ announcement: null, security: { status: "failed", error: "invalid_assertion" } });
        });
        return () => { active = false; };
    }, [localUserId, message.id, message.content, ownProof, revision]);

    if (ownProof) {
        return (
            <div className="pc-security-key-card pc-security-key-proof">
                <div className="pc-security-key-card-header"><HardwareKeyIcon /> Your hardware identity proof</div>
                <code className="pc-security-key-fingerprint">{formatSecurityKeyFingerprint(proof.rootFingerprint)}</code>
                <BaseText size="xs" color="text-muted">
                    This binds your current Discord account and current Secure Messaging identity to the security key.
                </BaseText>
            </div>
        );
    }

    if (!review) {
        return (
            <div className="pc-security-key-card pc-security-key-proof" aria-busy="true">
                <div className="pc-security-key-card-header"><HardwareKeyIcon /> Authenticating hardware identity proof…</div>
            </div>
        );
    }
    const { security } = review;
    if (isSecurityKeyFailure(security)) {
        return (
            <div className="pc-security-key-card pc-security-key-card-danger pc-security-key-proof">
                <div className="pc-security-key-card-header"><HardwareKeyIcon /> Hardware identity proof blocked</div>
                <BaseText size="sm">{securityKeyFailureMessage(security)}</BaseText>
            </div>
        );
    }
    if (!validSecurityReview(security)) {
        return (
            <div className="pc-security-key-card pc-security-key-card-danger pc-security-key-proof">
                <div className="pc-security-key-card-header"><HardwareKeyIcon /> Hardware identity proof blocked</div>
                <BaseText size="sm">
                    {security.status === "replay_detected"
                        ? "This hardware proof was copied to another message or conflicts with authenticated history."
                        : "The WebAuthn signature, user verification, account binding, or embedded encryption key is invalid."}
                </BaseText>
            </div>
        );
    }

    const { announcement } = review;
    const announcementTrusted = announcement?.status === "trusted";
    const fullyTrusted = security.status === "trusted" && announcementTrusted;
    const announcementBlocked = announcement && (announcement.status === "invalid_announcement" ||
        announcement.status === "stale_announcement" || isCoreFailure(announcement));
    const warning = !fullyTrusted;

    return (
        <div className={classes(
            "pc-security-key-card",
            "pc-security-key-proof",
            warning ? "pc-security-key-card-warning" : null,
            announcementBlocked ? "pc-security-key-card-danger" : null,
        )}>
            <div className="pc-security-key-card-header">
                <HardwareKeyIcon color={fullyTrusted ? "var(--status-positive)" : "var(--status-warning)"} />
                {fullyTrusted
                    ? "Verified through trusted hardware security key"
                    : security.status === "linked"
                        ? "Recognized hardware key on an additional Discord account"
                        : security.status === "key_changed"
                            ? "Hardware identity changed"
                            : security.status === "trusted" && announcement?.status === "key_changed"
                                ? "Trusted hardware key with a new device encryption key"
                                : "Hardware identity needs review"}
            </div>
            <RootDetails root={security.root} />
            <BaseText size="xs" color="text-muted">
                Proof author: {userLabel(message.author.id)} • {profileAlgorithmLabel(security.root.algorithm)} • user verification required
            </BaseText>

            {announcementBlocked && (
                <BaseText size="sm" className="pc-secure-status-danger">
                    {isCoreFailure(announcement!)
                        ? coreFailureMessage(announcement!)
                        : announcement!.status === "stale_announcement"
                            ? "The embedded encryption-key announcement is older than the currently trusted key."
                            : "The embedded encryption-key announcement is invalid."}
                </BaseText>
            )}

            {!fullyTrusted && !announcementBlocked && announcement && security.status !== "trusted" && (
                <div className="pc-security-key-actions">
                    <Button
                        size="xs"
                        variant={security.status === "key_changed" ? "dangerPrimary" : "primary"}
                        onClick={() => openModal(modalProps => (
                            <TrustProofModal
                                announcementReview={announcement}
                                message={message}
                                modalProps={modalProps}
                                onComplete={() => setRevision(value => value + 1)}
                                securityReview={security}
                            />
                        ))}
                    >
                        {security.status === "key_changed"
                            ? "Review changed hardware identity"
                            : security.status === "linked"
                                ? "Verify this linked account"
                                : "Review & verify"}
                    </Button>
                </div>
            )}

            {!fullyTrusted && !announcementBlocked && announcement && security.status === "trusted" &&
                (announcement.status === "trust_required" || announcement.status === "key_changed") && (
                <div className="pc-security-key-actions">
                    <Button
                        size="xs"
                        variant="primary"
                        onClick={() => void (async () => {
                            if (!localUserId) return;
                            try {
                                await trustEncryptionAnnouncement(
                                    localUserId,
                                    message.author.id,
                                    message,
                                    security.announcement,
                                    announcement,
                                );
                                showToast("Encryption key accepted through the trusted hardware identity.", Toasts.Type.SUCCESS);
                                MessageStore.emitChange();
                                setRevision(value => value + 1);
                            } catch (error) {
                                showToast(error instanceof Error ? error.message : "The encryption key was not trusted.", Toasts.Type.FAILURE);
                            }
                        })()}
                    >
                        {announcement.status === "key_changed" ? "Accept new device encryption key" : "Trust encryption key"}
                    </Button>
                </div>
            )}
        </div>
    );
}

function SecurityKeyProofAccessory({ message }: { message: Message; }) {
    const localUserId = UserStore.getCurrentUser()?.id;
    const encrypted = isEncryptedMessage(message.content);
    const cacheKey = encrypted && localUserId && message.author?.id ? decryptCacheKey(localUserId, message) : message.content;
    const captureReady = useStateFromStores([MessageStore], () =>
        secureMessagingRuntime()?.getScreenCaptureProtectionStatus?.() === "ready");
    const [plaintext, setPlaintext] = useState<string | null>(() =>
        !encrypted && isSecurityKeyProof(message.content) ? message.content : null);

    useEffect(() => {
        let active = true;
        if (!encrypted) {
            setPlaintext(isSecurityKeyProof(message.content) ? message.content : null);
            return () => { active = false; };
        }
        setPlaintext(null);
        if (!captureReady || !localUserId || !message.author?.id) return () => { active = false; };
        void decryptCachedMessage(localUserId, message).then(result => {
            if (active) setPlaintext(result.status === "decrypted" && isSecurityKeyProof(result.plaintext)
                ? result.plaintext
                : null);
        });
        return () => { active = false; };
    }, [cacheKey, captureReady, encrypted, localUserId, message.content]);

    if (!plaintext) return null;
    try {
        return <ProofCard message={message} proof={parseSecurityKeyProof(plaintext)} />;
    } catch {
        return (
            <div className="pc-security-key-card pc-security-key-card-danger pc-security-key-proof">
                <div className="pc-security-key-card-header"><HardwareKeyIcon /> Malformed hardware identity proof</div>
            </div>
        );
    }
}

const renderSecurityKeyAccessory: MessageAccessoryFactory = props => (
    <SecurityKeyProofAccessory message={props.message} />
);

export default definePlugin({
    name: "SecureMessagingSecurityKey",
    description: "Adds roaming FIDO2 security-key identity continuity to Secure Messaging.",
    authors: [EquicordDevs.creations],
    hidden: true,
    required: true,
    dependencies: ["ChatInputButtonAPI", "MessageAccessoriesAPI"],

    chatBarButton: {
        icon: HardwareKeyIcon,
        render: SecurityKeyButton,
    },

    start() {
        addMessageAccessory("SecureMessagingSecurityKey", renderSecurityKeyAccessory, 5);
    },

    stop() {
        removeMessageAccessory("SecureMessagingSecurityKey");
    },
});
