/**
 * Byte-level "changed at all" check for scene files — plan §4.1/§4.3, first comparison level.
 *
 * Hash the RAW bytes (or text, UTF-8 encoded) that were read from or written to disk. Never hash
 * a re-serialization (`SceneSaver`, `yaml.stringify`): two writers format the same values
 * differently, and "did the file change" must not depend on who formatted it. Whether a
 * PROPERTY changed is a different question, answered by `value-equality.ts`.
 *
 * Isomorphic: WebCrypto (`globalThis.crypto.subtle`, browsers and Node >= 19) with a `node:crypto`
 * fallback for runtimes that lack it.
 */

interface NodeCryptoModule {
  createHash(algorithm: string): { update(data: Uint8Array): { digest(encoding: 'hex'): string } };
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Lowercase hex SHA-256 of the given bytes (a string is hashed as UTF-8). */
export async function sha256(content: string | Uint8Array): Promise<string> {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    // Copy into a fresh ArrayBuffer-backed view: `digest` rejects SharedArrayBuffer views.
    return toHex(await subtle.digest('SHA-256', new Uint8Array(bytes)));
  }
  const specifier = 'node:crypto';
  const nodeCrypto = (await import(/* @vite-ignore */ specifier)) as NodeCryptoModule;
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex');
}
