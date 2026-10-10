import { LazyComponent } from "@utils/lazyReact";
import type { Plugin } from "@utils/types";
import { openModal } from "@webpack/common";

import { promptToRestartIfDirty } from "../settings/restartTracking";
import { setSettingsModalOpen } from "../state";

const PluginModal = LazyComponent(() =>
    (require("@components/settings/tabs/plugins/PluginModal") as typeof import("@components/settings/tabs/plugins/PluginModal")).default
);

export function openQuestifySettingsModal(plugin: Plugin): void {
    setSettingsModalOpen(true);

    openModal(
        modalProps => (
            <PluginModal
                {...modalProps}
                plugin={plugin}
                onRestartNeeded={() => { }}
            />
        ),
        {
            onCloseCallback: () => {
                setSettingsModalOpen(false);
                promptToRestartIfDirty();
            }
        }
    );
}
