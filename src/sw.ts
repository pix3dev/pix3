/// <reference lib="webworker" />

import { binaryTemplates, sceneTemplates } from '@/services/project/template-data';

declare const self: ServiceWorkerGlobalScope;

const DB_NAME = 'pix3-db';
const STORE_NAME = 'handles';
const HANDLE_KEY = 'project-root';

async function getProjectHandle(): Promise<FileSystemDirectoryHandle | null> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = event => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = event => {
      const db = (event.target as IDBOpenDBRequest).result;
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const getReq = store.get(HANDLE_KEY);
      getReq.onsuccess = () => resolve(getReq.result as FileSystemDirectoryHandle);
      getReq.onerror = () => reject(getReq.error);
    };
    request.onerror = () => reject(request.error);
  });
}

async function getFileHandle(
  root: FileSystemDirectoryHandle,
  path: string
): Promise<FileSystemFileHandle> {
  const parts = path.split('/').filter(p => p.length > 0);
  let currentHandle: FileSystemDirectoryHandle | FileSystemFileHandle = root;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (currentHandle.kind !== 'directory') {
      throw new Error(`Path ${path} is invalid: ${parts[i - 1]} is not a directory`);
    }
    const dirHandle = currentHandle as FileSystemDirectoryHandle;
    if (i === parts.length - 1) {
      // Last part, try to get file
      try {
        return await dirHandle.getFileHandle(part);
      } catch {
        // If not found as file, maybe it's a directory? But we need a file.
        throw new Error(`File not found: ${path}`);
      }
    } else {
      // Intermediate part, must be directory
      currentHandle = await dirHandle.getDirectoryHandle(part);
    }
  }
  throw new Error(`Path ${path} resolves to a directory, not a file`);
}

async function handleResRequest(url: URL): Promise<Response> {
  try {
    const root = await getProjectHandle();
    if (!root) {
      return new Response('Project not open', { status: 404 });
    }

    // url.pathname includes the leading slash, e.g. /models/duck.glb
    const path = decodeURIComponent(url.pathname);
    const handle = await getFileHandle(root, path);
    const file = await handle.getFile();
    return new Response(file, {
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'Content-Length': file.size.toString(),
      },
    });
  } catch (error) {
    console.error('SW: Failed to serve res://', url.href, error);
    return new Response('File not found', { status: 404 });
  }
}

async function handleTemplRequest(url: URL): Promise<Response> {
  // templ://Duck.glb -> pathname is //Duck.glb or /Duck.glb depending on browser
  // We strip leading slashes
  const id = decodeURIComponent(url.pathname).replace(/^\/+/, '');

  // Check binary templates
  const binary = binaryTemplates.find(t => t.id === id);
  if (binary) {
    // Fetch the actual URL
    const response = await fetch(binary.url);
    return response;
  }

  // Check scene templates (return as text/json)
  const scene = sceneTemplates.find(t => t.id === id);
  if (scene) {
    return new Response(scene.contents, {
      headers: { 'Content-Type': 'text/yaml' }, // or application/json if it was json
    });
  }

  return new Response('Template not found', { status: 404 });
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (url.protocol === 'res:') {
    event.respondWith(handleResRequest(url));
    return;
  }

  if (url.protocol === 'templ:') {
    event.respondWith(handleTemplRequest(url));
    return;
  }
});
