export interface AutoloadConfig {
    scriptPath: string;
    singleton: string;
    enabled: boolean;
}
export interface ProjectManifest {
    version: string;
    autoloads: AutoloadConfig[];
    metadata?: Record<string, unknown>;
}
