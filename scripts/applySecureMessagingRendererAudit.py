from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INDEX = "src/equicordplugins/secureMessaging.desktop/index.tsx"
WORKFLOW = ROOT / ".github/workflows/apply-secure-messaging-renderer-audit.yml"
SCRIPT = Path(__file__)


def replace_once(path: str, old: str, new: str) -> None:
    file = ROOT / path
    source = file.read_text()
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"Expected one match in {path}, found {count}: {old.splitlines()[0]!r}")
    file.write_text(source.replace(old, new, 1))


def replace_section(path: str, start_marker: str, end_marker: str, replacement: str) -> None:
    file = ROOT / path
    source = file.read_text()
    if source.count(start_marker) != 1 or source.count(end_marker) != 1:
        raise SystemExit(f"Section markers were not unique in {path}: {start_marker!r}, {end_marker!r}")
    start = source.index(start_marker)
    end = source.index(end_marker, start)
    file.write_text(source[:start] + replacement + source[end:])


replace_once(
    INDEX,
    'import {\n    clearEncryptedAttachmentCache,\n',
    'import {\n    announcementReviewCacheKey,\n    clearAnnouncementReviewCache,\n    reviewAnnouncementCached,\n} from "./announcementReviewCache";\nimport {\n    clearEncryptedAttachmentCache,\n',
)

replace_section(
    INDEX,
    "interface PendingRenderDecryption {",
    "async function saveEncryptedAttachment(url: string): Promise<void> {",
    '''interface SettledRenderDecryption {
    apply(result: DecryptIncomingResult): void;
    channelId: string;
    generation: number;
    result: DecryptIncomingResult;
}

const RENDER_DECRYPT_BATCH_SIZE = 24;

let screenCaptureProtectionStatus: ScreenCaptureProtectionStatus = "disabled";
let screenCaptureProtectionGeneration = 0;
let secureOperationGeneration = 0;
let secureMessageListenersInstalled = false;
const screenCaptureProtectionListeners = new Set<(status: ScreenCaptureProtectionStatus) => void>();
const secureMessageGroupingListeners = new Map<string, Set<() => void>>();
const secureMessageGroupingRevisions = new Map<string, number>();
const pendingSecureMessageGroupingChannels = new Set<string>();
const nativeMessageGroupStartObservations = new Map<string, Map<object, boolean>>();
const pendingEncryptedRenderOwners = new Set<{ forceUpdate(): void; }>();
let secureMessageGroupingNotificationScheduled = false;
let settledRenderDecryptions: SettledRenderDecryption[] = [];
let renderDecryptBatchTimer: ReturnType<typeof setTimeout> | null = null;

function groupObservationKey(channelId: string, messageId: string): string {
    return `${channelId}\\0${messageId}`;
}

function flushSecureMessageGroupingChanges(): void {
    secureMessageGroupingNotificationScheduled = false;
    const channelIds = [...pendingSecureMessageGroupingChannels];
    pendingSecureMessageGroupingChannels.clear();
    for (const channelId of channelIds) {
        const listeners = secureMessageGroupingListeners.get(channelId);
        if (!listeners?.size) continue;
        const revision = (secureMessageGroupingRevisions.get(channelId) ?? 0) + 1;
        secureMessageGroupingRevisions.set(channelId, revision);
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch {
                // A stale accessory must not prevent the rest of this channel from settling.
            }
        }
    }
}

function notifySecureMessageGroupingChanged(channelId: string): void {
    pendingSecureMessageGroupingChannels.add(channelId);
    if (secureMessageGroupingNotificationScheduled) return;
    secureMessageGroupingNotificationScheduled = true;
    queueMicrotask(flushSecureMessageGroupingChanges);
}

function useSecureMessageGroupingRevision(channelId: string): number {
    const [revision, setRevision] = useState(() => secureMessageGroupingRevisions.get(channelId) ?? 0);
    useLayoutEffect(() => {
        const listener = () => setRevision(secureMessageGroupingRevisions.get(channelId) ?? 0);
        let listeners = secureMessageGroupingListeners.get(channelId);
        if (!listeners) {
            listeners = new Set();
            secureMessageGroupingListeners.set(channelId, listeners);
        }
        listeners.add(listener);
        listener();
        return () => {
            listeners?.delete(listener);
            if (!listeners?.size) {
                secureMessageGroupingListeners.delete(channelId);
                secureMessageGroupingRevisions.delete(channelId);
                pendingSecureMessageGroupingChannels.delete(channelId);
            }
        };
    }, [channelId]);
    return revision;
}

function observedNativeMessageGroupStart(channelId: string, messageId: string): boolean | null {
    const observations = nativeMessageGroupStartObservations.get(groupObservationKey(channelId, messageId));
    if (!observations?.size) return null;
    for (const groupStart of observations.values()) {
        if (groupStart) return true;
    }
    return false;
}

function setNativeMessageGroupStartObservation(
    channelId: string,
    messageId: string,
    owner: object,
    groupStart: boolean,
): void {
    const key = groupObservationKey(channelId, messageId);
    const previous = observedNativeMessageGroupStart(channelId, messageId);
    let observations = nativeMessageGroupStartObservations.get(key);
    if (!observations) {
        observations = new Map();
        nativeMessageGroupStartObservations.set(key, observations);
    }
    observations.set(owner, groupStart);
    if (previous !== observedNativeMessageGroupStart(channelId, messageId))
        notifySecureMessageGroupingChanged(channelId);
}

function removeNativeMessageGroupStartObservation(channelId: string, messageId: string, owner: object): void {
    const key = groupObservationKey(channelId, messageId);
    const observations = nativeMessageGroupStartObservations.get(key);
    if (!observations?.has(owner)) return;
    const previous = observedNativeMessageGroupStart(channelId, messageId);
    observations.delete(owner);
    if (!observations.size) nativeMessageGroupStartObservations.delete(key);
    if (previous !== observedNativeMessageGroupStart(channelId, messageId))
        notifySecureMessageGroupingChanged(channelId);
}

function scheduleRenderDecryptBatch(): void {
    if (renderDecryptBatchTimer !== null) return;
    renderDecryptBatchTimer = setTimeout(flushRenderDecryptions, 0);
}

function flushRenderDecryptions(): void {
    renderDecryptBatchTimer = null;
    const batch = settledRenderDecryptions.splice(0, RENDER_DECRYPT_BATCH_SIZE);
    if (batch.length === 0) return;
    const generation = secureOperationGeneration;
    const changedChannels = new Set<string>();
    ReactDOM.flushSync(() => {
        for (const request of batch) {
            if (request.generation !== generation) continue;
            try {
                request.apply(request.result);
                changedChannels.add(request.channelId);
            } catch {
                // Discord may dispose a row between decryption and the bounded render batch.
            }
        }
    });
    for (const channelId of changedChannels) notifySecureMessageGroupingChanged(channelId);
    if (settledRenderDecryptions.length > 0) scheduleRenderDecryptBatch();
}

function enqueueSettledRenderDecryption(request: SettledRenderDecryption): void {
    if (request.generation !== secureOperationGeneration) return;
    settledRenderDecryptions.push(request);
    scheduleRenderDecryptBatch();
}

function decryptCachedMessageForRender(
    localUserId: string,
    message: Message,
    apply: (result: DecryptIncomingResult) => void,
): void {
    const generation = secureOperationGeneration;
    void decryptCachedMessage(localUserId, message).then(
        result => enqueueSettledRenderDecryption({
            apply,
            channelId: message.channel_id,
            generation,
            result,
        }),
        () => enqueueSettledRenderDecryption({
            apply,
            channelId: message.channel_id,
            generation,
            result: { status: "failed", error: "cryptographic_operation_failed" },
        }),
    );
}

''',
)

replace_once(
    INDEX,
    '''    } else if (!key) content = "Encrypted message blocked";
    else content = replyPreviewText(
        state?.key === key ? state.result : getCachedDecryption(localUserId!, message),
    );
''',
    '''    } else if (!key || !localUserId) content = "Encrypted message blocked";
    else content = replyPreviewText(
        state?.key === key ? state.result : getCachedDecryption(localUserId, message),
    );
''',
)

replace_once(
    INDEX,
    '''const permittedAnnouncements = new Map<string, number>();
const keyReviewGate = new KeyReviewGate();
''',
    '''const permittedAnnouncements = new Map<string, number>();
const keyReviewGate = new KeyReviewGate();
const backgroundAnnouncementReviews = new Set<string>();
let announcementReviewGeneration = 0;
''',
)
replace_once(INDEX, "const messageLengthBypassKeys = new Set<string>();\n", "let activeMessageLengthBypassKey: string | null = null;\n")

replace_section(
    INDEX,
    "function messageLengthBypassKey(localUserId: string, channelId: string): string {",
    "function announcementKey(channelId: string, content: string): string {",
    '''function messageLengthBypassKey(localUserId: string, channelId: string): string {
    return `${localUserId}\\0${channelId}`;
}

function updateMessageLengthBypass(
    context: { localUserId: string; snapshot: ConversationSnapshot; },
    conversation: ConversationResult,
): boolean {
    if (UserStore.getCurrentUser()?.id !== context.localUserId ||
        SelectedChannelStore.getChannelId() !== context.snapshot.channelId) return false;
    const enabled = !isNativeFailure(conversation) && conversation.status === "enabled";
    activeMessageLengthBypassKey = enabled
        ? messageLengthBypassKey(context.localUserId, context.snapshot.channelId)
        : null;
    return enabled;
}

async function refreshMessageLengthBypassState(channelId = SelectedChannelStore.getChannelId()): Promise<boolean> {
    const generation = ++messageLengthBypassGeneration;
    activeMessageLengthBypassKey = null;
    const localUserId = UserStore.getCurrentUser()?.id;
    if (!localUserId || !channelId) return false;
    const snapshot = snapshotForChannel(ChannelStore.getChannel(channelId), localUserId);
    if (!snapshot) return false;
    const context = { localUserId, snapshot };
    try {
        const conversation = await Native.getConversation(localUserId, snapshot);
        if (generation !== messageLengthBypassGeneration || UserStore.getCurrentUser()?.id !== localUserId ||
            SelectedChannelStore.getChannelId() !== channelId) return false;
        return updateMessageLengthBypass(context, conversation);
    } catch {
        return false;
    }
}

function shouldBypassMessageLengthLimit(): boolean {
    const localUserId = UserStore.getCurrentUser()?.id;
    const channelId = SelectedChannelStore.getChannelId();
    return screenCaptureProtectionStatus === "ready" && Boolean(
        localUserId && channelId && activeMessageLengthBypassKey === messageLengthBypassKey(localUserId, channelId),
    );
}

function handleSelectedChannelChange(): void {
    activeMessageLengthBypassKey = null;
    void refreshMessageLengthBypassState();
    updateSelectedChatUnlockPrompt();
}

function installMessageLengthBypass(): void {
    if (!selectedChannelListenerInstalled) {
        SelectedChannelStore.addChangeListener(handleSelectedChannelChange);
        selectedChannelListenerInstalled = true;
    }
    addMessageLengthBypassListener(shouldBypassMessageLengthLimit);
    void refreshMessageLengthBypassState();
}

function uninstallMessageLengthBypass(): void {
    messageLengthBypassGeneration++;
    activeMessageLengthBypassKey = null;
    if (selectedChannelListenerInstalled) {
        SelectedChannelStore.removeChangeListener(handleSelectedChannelChange);
        selectedChannelListenerInstalled = false;
    }
    removeMessageLengthBypassListener(shouldBypassMessageLengthLimit);
}

function resetAnnouncementReviewState(): void {
    announcementReviewGeneration++;
    backgroundAnnouncementReviews.clear();
    clearAnnouncementReviewCache();
    keyReviewGate.clear();
}

function revokePreparedSecureOperations(): void {
    clearWirePayloadAuthorizations();
    permittedAnnouncements.clear();
    approvedAttachmentUploads = new WeakMap();
    detachedTextUploads = new WeakSet();
    preparedOutgoingMessages = new WeakMap();
    clearOptimisticOutgoingPlaintexts();
    requestAuthorizationScopes = new WeakMap();
    resetAnnouncementReviewState();
}

''',
)

replace_section(
    INDEX,
    "function reviewKeyAnnouncementInBackground(message: Message | undefined): void {",
    "function messageFromDispatch(event: Record<string, any>): Message | undefined {",
    '''function reviewKeyAnnouncementInBackground(message: Message | undefined): void {
    const localUserId = UserStore.getCurrentUser()?.id;
    const peerUserId = message?.author?.id;
    if (!message || !localUserId || !peerUserId || peerUserId === localUserId || !isKeyAnnouncement(message.content)) return;
    const messageGuildId = (message as Message & { guild_id?: string; }).guild_id;
    if (messageGuildId || ChannelStore.getChannel(message.channel_id)?.guild_id) return;
    const attemptId = announcementReviewCacheKey(localUserId, message);
    if (backgroundAnnouncementReviews.has(attemptId)) return;

    const generation = announcementReviewGeneration;
    backgroundAnnouncementReviews.add(attemptId);
    keyReviewGate.begin(localUserId, peerUserId);
    void reviewAnnouncementCached(localUserId, message)
        .then(result => {
            if (generation !== announcementReviewGeneration || UserStore.getCurrentUser()?.id !== localUserId) return;
            if (isNativeFailure(result)) keyReviewGate.fail(localUserId, peerUserId, attemptId);
            else {
                keyReviewGate.succeed(localUserId, peerUserId, attemptId);
                if (result.status === "key_changed") {
                    invalidateSecureRenderCaches();
                    void refreshMessageLengthBypassState();
                }
            }
        })
        .catch(() => {
            if (generation === announcementReviewGeneration && UserStore.getCurrentUser()?.id === localUserId)
                keyReviewGate.fail(localUserId, peerUserId, attemptId);
        })
        .finally(() => {
            backgroundAnnouncementReviews.delete(attemptId);
            if (generation === announcementReviewGeneration) keyReviewGate.finish(localUserId, peerUserId);
        });
}

''',
)

replace_once(
    INDEX,
    '''    if (accountChanged) {
        secureOperationGeneration++;
        revokePreparedSecureOperations();
        messageLengthBypassKeys.clear();
        suppressedChatLoadChannelIds.clear();
        invalidateSecureRenderCaches();
        try {
            await Native.lockSecurityKeyVault();
        } catch {
            // The native process still clears its in-memory key on process exit; renderer state fails closed.
        }
    }
    invalidateSecureRenderCaches();
''',
    '''    if (accountChanged) {
        secureOperationGeneration++;
        revokePreparedSecureOperations();
        activeMessageLengthBypassKey = null;
        suppressedChatLoadChannelIds.clear();
        try {
            await Native.lockSecurityKeyVault();
        } catch {
            // The native process still clears its in-memory key on process exit; renderer state fails closed.
        }
    }
    invalidateSecureRenderCaches();
''',
)

replace_once(
    INDEX,
    '''                if (forgotten.status === "forgotten") invalidateSecureRenderCaches();
                reviewed = await Native.reviewAnnouncement(
''',
    '''                if (forgotten.status === "forgotten") {
                    resetAnnouncementReviewState();
                    invalidateSecureRenderCaches();
                }
                reviewed = await Native.reviewAnnouncement(
''',
)
replace_once(
    INDEX,
    '''            if (trusted.status === "trusted" || trusted.status === "already_trusted") {
                invalidateSecureRenderCaches();
                showToast(`Verified Secure Messaging key for ${userLabel(peerUserId)}.`, Toasts.Type.SUCCESS);
''',
    '''            if (trusted.status === "trusted" || trusted.status === "already_trusted") {
                resetAnnouncementReviewState();
                invalidateSecureRenderCaches();
                void refreshMessageLengthBypassState();
                showToast(`Verified Secure Messaging key for ${userLabel(peerUserId)}.`, Toasts.Type.SUCCESS);
''',
)

replace_section(
    INDEX,
    "function KeyAnnouncementAccessory({ message }: { message: Message; }) {",
    "function SecureMessageAccessory({ message, nativeGroupStart }: { message: Message; nativeGroupStart?: boolean; }) {",
    '''function KeyAnnouncementAccessory({ message }: { message: Message; }) {
    const localUserId = UserStore.getCurrentUser()?.id;
    const peerUserId = message.author?.id;
    const reviewKey = localUserId && peerUserId && peerUserId !== localUserId
        ? announcementReviewCacheKey(localUserId, message)
        : null;
    const [state, setState] = useState<{ key: string; result: AnnouncementReviewResult; } | null>(null);
    const review = state?.key === reviewKey ? state.result : null;

    useEffect(() => {
        let active = true;
        setState(null);
        if (!reviewKey || !localUserId || !peerUserId || peerUserId === localUserId) return () => { active = false; };
        const generation = announcementReviewGeneration;
        keyReviewGate.begin(localUserId, peerUserId);
        void reviewAnnouncementCached(localUserId, message)
            .then(result => {
                if (generation !== announcementReviewGeneration || UserStore.getCurrentUser()?.id !== localUserId) return;
                if (isNativeFailure(result)) keyReviewGate.fail(localUserId, peerUserId, reviewKey);
                else keyReviewGate.succeed(localUserId, peerUserId, reviewKey);
                if (active) setState({ key: reviewKey, result });
            })
            .catch(() => {
                if (generation !== announcementReviewGeneration || UserStore.getCurrentUser()?.id !== localUserId) return;
                keyReviewGate.fail(localUserId, peerUserId, reviewKey);
                if (active) setState({
                    key: reviewKey,
                    result: { status: "failed", error: "cryptographic_operation_failed" },
                });
            })
            .finally(() => {
                if (generation === announcementReviewGeneration) keyReviewGate.finish(localUserId, peerUserId);
            });
        return () => { active = false; };
    }, [localUserId, peerUserId, reviewKey]);

    if (peerUserId === localUserId && localUserId) {
        return (
            <div className="pc-secure-card pc-secure-replaces-content">
                <div className="pc-secure-card-header">🔑 Your Secure Messaging public-key announcement</div>
                <BaseText size="xs" color="text-muted">Recipients must compare its fingerprint with you outside Discord.</BaseText>
            </div>
        );
    }
    if (!localUserId || !peerUserId) {
        return (
            <div className="pc-secure-card pc-secure-card-danger pc-secure-replaces-content">
                <div className="pc-secure-card-header">🔑 Secure Messaging key unavailable</div>
                <BaseText size="xs">Discord's authenticated account or announcement author is unavailable.</BaseText>
            </div>
        );
    }
    if (!review) {
        return (
            <div className="pc-secure-card pc-secure-replaces-content">
                <div className="pc-secure-card-header">🔑 Verifying public-key announcement…</div>
            </div>
        );
    }
    if (review.status === "invalid_announcement" || isNativeFailure(review)) {
        return (
            <div className="pc-secure-card pc-secure-card-danger pc-secure-replaces-content">
                <div className="pc-secure-card-header">🔑 Invalid Secure Messaging key announcement</div>
                {isNativeFailure(review) && <BaseText size="xs">{failureMessage(review)}</BaseText>}
            </div>
        );
    }
    if (review.status === "stale_announcement") {
        return (
            <div className="pc-secure-card pc-secure-replaces-content">
                <div className="pc-secure-card-header">🔑 Older Secure Messaging key announcement ignored</div>
                <BaseText size="xs" color="text-muted">
                    A newer key is already verified for this person. This historical announcement cannot replace or disable it.
                </BaseText>
                <code className="pc-secure-fingerprint">{review.trustedIdentity.formattedFingerprint}</code>
            </div>
        );
    }

    const trusted = review.status === "trusted";
    return (
        <div className={`pc-secure-card pc-secure-replaces-content ${review.status === "key_changed" ? "pc-secure-card-danger" : "pc-secure-card-warning"}`}>
            <div className="pc-secure-card-header">
                🔑 {trusted ? "Verified Secure Messaging key" : review.status === "key_changed" ? "Encryption key changed" : "Encryption key needs verification"}
            </div>
            <code className="pc-secure-fingerprint">{review.identity.formattedFingerprint}</code>
            {!trusted && (
                <div className="pc-secure-card-actions">
                    <Button size="xs" variant={review.status === "key_changed" ? "dangerPrimary" : "primary"} onClick={() => openKeyReviewModal(message, review, localUserId)}>
                        {review.status === "key_changed" ? "Review changed key" : "Review & verify"}
                    </Button>
                </div>
            )}
        </div>
    );
}

''',
)

replace_once(INDEX, "    const groupingRevision = useSecureMessageGroupingRevision();\n", "    const groupingRevision = useSecureMessageGroupingRevision(message.channel_id);\n")
replace_once(
    INDEX,
    '''        }, candidate => candidate.id === message.id && nativeGroupStart === true
            ? true
            : observedNativeMessageGroupStart(candidate.id));
''',
    '''        }, candidate => candidate.id === message.id && nativeGroupStart === true
            ? true
            : observedNativeMessageGroupStart(message.channel_id, candidate.id));
''',
)
replace_once(
    INDEX,
    '''        setNativeMessageGroupStartObservation(message.id, groupStartObservationOwner, detectedGroupStart);
        return () => removeNativeMessageGroupStartObservation(message.id, groupStartObservationOwner);
    }, [groupStartObservationOwner, message.id, nativeGroupStart]);
''',
    '''        setNativeMessageGroupStartObservation(message.channel_id, message.id, groupStartObservationOwner, detectedGroupStart);
        return () => removeNativeMessageGroupStartObservation(message.channel_id, message.id, groupStartObservationOwner);
    }, [groupStartObservationOwner, message.channel_id, message.id, nativeGroupStart]);
''',
)

replace_section(
    INDEX,
    "    start() {\n        secureOperationGeneration++;",
    "    shouldGateChat(target: Channel | { channelId: string; }, owner?: { forceUpdate(): void; }) {",
    '''    start() {
        secureOperationGeneration++;
        if (secureMessageListenersInstalled) {
            removeMessagePreSendListener(outgoingListener);
            removeMessagePreEditListener(editListener);
            secureMessageListenersInstalled = false;
        }
        secureRuntimeUserId = UserStore.getCurrentUser()?.id ?? null;
        chatAccessGateEnabled = true;
        chatAccessGeneration++;
        chatAccessCache = { status: "pending", localUserId: secureRuntimeUserId };
        const generation = ++screenCaptureProtectionGeneration;
        setScreenCaptureProtectionStatus("pending");
        try {
            installAttachmentUploadGuard();
            installNetworkGuard();
            installEncryptedEditStarter();
            installChatLoadGuard();
            installMessageLengthBypass();
            document.addEventListener("click", handleEncryptedAttachmentDownload, true);
            addMessageAccessory("SecureMessaging", renderSecureMessageAccessory, 0);
        } catch {
            chatAccessGateEnabled = false;
            chatAccessGeneration++;
            refreshChatGateRenderers();
            document.removeEventListener("click", handleEncryptedAttachmentDownload, true);
            try {
                removeMessageAccessory("SecureMessaging");
            } catch {
                // The accessory API may not have completed registration.
            }
            uninstallMessageLengthBypass();
            uninstallChatLoadGuard();
            uninstallEncryptedEditStarter();
            uninstallNetworkGuard();
            uninstallAttachmentUploadGuard();
            setScreenCaptureProtectionStatus("failed");
            showToast("Secure Messaging could not install its application guards.", Toasts.Type.FAILURE);
            return;
        }
        void refreshChatAccessState(secureRuntimeUserId);
        void applyScreenCaptureProtection(true).then(applied => {
            if (generation !== screenCaptureProtectionGeneration) return;
            if (!applied) {
                setScreenCaptureProtectionStatus("failed");
                return;
            }
            setScreenCaptureProtectionStatus("ready");
            try {
                addMessagePreSendListener(outgoingListener, { priority: SECURE_LISTENER_PRIORITY, cancelOnError: true });
                addMessagePreEditListener(editListener, { priority: SECURE_LISTENER_PRIORITY, cancelOnError: true });
                secureMessageListenersInstalled = true;
            } catch {
                removeMessagePreSendListener(outgoingListener);
                removeMessagePreEditListener(editListener);
                setScreenCaptureProtectionStatus("failed");
                showToast("Secure Messaging could not install its protected message listeners.", Toasts.Type.FAILURE);
            }
        }).catch(() => {
            if (generation !== screenCaptureProtectionGeneration) return;
            setScreenCaptureProtectionStatus("failed");
            showToast("Secure Messaging could not initialize encrypted-content protection.", Toasts.Type.FAILURE);
        });
    },

    stop() {
        try {
            removeMessageAccessory("SecureMessaging");
        } catch {
            // Stopping must continue even if Discord already removed the accessory registry entry.
        }
        secureOperationGeneration++;
        secureRuntimeUserId = null;
        chatAccessGateEnabled = false;
        chatAccessGeneration++;
        chatAccessCache = { status: "pending", localUserId: null };
        suppressedChatLoadChannelIds.clear();
        closeChatUnlockPrompt();
        refreshChatGateRenderers();
        screenCaptureProtectionGeneration++;
        setScreenCaptureProtectionStatus("disabled");
        document.removeEventListener("click", handleEncryptedAttachmentDownload, true);
        uninstallMessageLengthBypass();
        uninstallChatLoadGuard();
        uninstallEncryptedEditStarter();
        uninstallAttachmentUploadGuard();
        uninstallNetworkGuard();
        void Native.setScreenCaptureProtection(true).catch(() => undefined);
        if (secureMessageListenersInstalled) {
            removeMessagePreSendListener(outgoingListener);
            removeMessagePreEditListener(editListener);
            secureMessageListenersInstalled = false;
        }
        permittedAnnouncements.clear();
        if (renderDecryptBatchTimer !== null) clearTimeout(renderDecryptBatchTimer);
        renderDecryptBatchTimer = null;
        settledRenderDecryptions = [];
        secureMessageGroupingNotificationScheduled = false;
        pendingSecureMessageGroupingChannels.clear();
        secureMessageGroupingListeners.clear();
        secureMessageGroupingRevisions.clear();
        nativeMessageGroupStartObservations.clear();
        revokePreparedSecureOperations();
        void Native.lockSecurityKeyVault().catch(() => undefined);
        clearEncryptedAttachmentCache();
        clearEncryptedEmbedCache();
        clearEncryptedMessageDecryptCache();
    },

''',
)

WORKFLOW.unlink()
SCRIPT.unlink()
