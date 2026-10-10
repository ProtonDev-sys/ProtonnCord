export interface AbsSession {
    updatedAt?: number;
    isFinished?: boolean;
    mediaMetadata?: {
        title?: string;
        author?: string;
        publisher?: string;
        authors?: { name?: string; }[];
        series?: { name?: string; }[];
    };
    mediaType?: string;
    duration?: number;
    currentTime?: number;
    libraryItemId?: string;
}

export interface AbsMediaData {
    name: string;
    type: string;
    author?: string;
    series?: string;
    duration?: number;
    currentTime?: number;
    imageUrl?: string;
    isFinished?: boolean;
}
