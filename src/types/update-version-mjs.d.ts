declare module '../../scripts/update-version.mjs' {
  export interface VersionManifest {
    version: string;
    build: number;
    displayVersion: string;
    publishedAt?: string;
  }

  export interface UpdateVersionArtifactsOptions {
    publishedAt?: string;
    paths?: {
      packageJsonPath?: string;
      publicVersionPath?: string;
      sourceVersionPath?: string;
    };
  }

  export interface SyncedWorkspaceVersion {
    path: string;
    name: string;
    previous: string;
    version: string;
  }

  export function readJsonFile<T>(path: string, fallback: T): Promise<T>;
  export function syncWorkspaceVersions(
    version: string,
    paths?: string[]
  ): Promise<SyncedWorkspaceVersion[]>;
  export function buildVersionManifest(
    version: string,
    build: number,
    publishedAt?: string
  ): VersionManifest;
  export function buildVersionModule(manifest: VersionManifest): string;
  export function updateVersionArtifacts(
    options?: UpdateVersionArtifactsOptions
  ): Promise<VersionManifest>;
}
