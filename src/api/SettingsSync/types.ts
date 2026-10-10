export interface ManifestEntry {
    key: string;
    version: number;
    checksum: string;
}

export interface SyncUpload {
    key: string;
    value: string;
    checksum?: string;
}

export interface SyncRequest {
    client_manifest: ManifestEntry[];
    uploads: SyncUpload[];
}

export interface SyncDownload {
    key: string;
    value: string;
    version: number;
    checksum: string;
}

export interface SyncUploadResult {
    key: string;
    version: number;
    checksum: string;
}

export interface SyncError {
    key: string;
    error: string;
}

export interface SyncResponse {
    server_manifest: ManifestEntry[];
    downloads: SyncDownload[];
    uploaded: SyncUploadResult[];
    errors: SyncError[];
}
