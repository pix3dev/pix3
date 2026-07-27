export interface TextureResourceRef {
  type: 'texture';
  url: string;
}

export function isTextureResourceRef(value: unknown): value is TextureResourceRef {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as { type?: unknown; url?: unknown };
  return candidate.type === 'texture' && typeof candidate.url === 'string';
}

export function coerceTextureResource(value: unknown): TextureResourceRef | null {
  if (typeof value === 'string') {
    const url = value.trim();
    return url.length > 0 ? { type: 'texture', url } : null;
  }

  if (isTextureResourceRef(value)) {
    const url = value.url.trim();
    return url.length > 0 ? { type: 'texture', url } : null;
  }

  if (typeof value === 'object' && value !== null) {
    const maybeWithUrl = value as { url?: unknown };
    if (typeof maybeWithUrl.url === 'string') {
      const url = maybeWithUrl.url.trim();
      return url.length > 0 ? { type: 'texture', url } : null;
    }
  }

  return null;
}
