export let initialQuestDataFetched = false;
let settingsModalOpen = false;

export function setInitialQuestDataFetched(fetched: boolean): void {
    initialQuestDataFetched = fetched;
}

export function setSettingsModalOpen(open: boolean): void {
    settingsModalOpen = open;
}

export function getSettingsModalOpen(): boolean {
    return settingsModalOpen;
}
