import { describe, expect, it } from 'vitest';
import {
  classifyStatus,
  fileTypeFromMime,
  readCode,
  readModelUrl,
  readTaskId,
  readUploadToken,
} from '@/services/model-gen/neural/TripoModelProvider';

describe('readUploadToken', () => {
  it('reads data.image_token', () => {
    expect(readUploadToken({ code: 0, data: { image_token: 'tok-a' } })).toBe('tok-a');
  });

  it('falls back to data.file_token', () => {
    expect(readUploadToken({ code: 0, data: { file_token: 'tok-b' } })).toBe('tok-b');
  });

  it('falls back to data.token', () => {
    expect(readUploadToken({ code: 0, data: { token: 'tok-c' } })).toBe('tok-c');
  });

  it('prefers image_token over the other aliases', () => {
    expect(readUploadToken({ data: { image_token: 'a', file_token: 'b', token: 'c' } })).toBe('a');
  });

  it('returns null when no token field is present or the value is empty', () => {
    expect(readUploadToken({ code: 0, data: {} })).toBeNull();
    expect(readUploadToken({ code: 0, data: { image_token: '' } })).toBeNull();
    expect(readUploadToken({})).toBeNull();
    expect(readUploadToken(null)).toBeNull();
    expect(readUploadToken('garbage')).toBeNull();
  });
});

describe('readTaskId', () => {
  it('reads data.task_id', () => {
    expect(readTaskId({ code: 0, data: { task_id: 'task-1' } })).toBe('task-1');
  });

  it('returns null when absent, empty, or non-string', () => {
    expect(readTaskId({ code: 0, data: {} })).toBeNull();
    expect(readTaskId({ code: 0, data: { task_id: '' } })).toBeNull();
    expect(readTaskId({ code: 0, data: { task_id: 42 } })).toBeNull();
    expect(readTaskId(null)).toBeNull();
  });
});

describe('readModelUrl', () => {
  it('reads output.pbr_model first', () => {
    expect(
      readModelUrl({
        output: { pbr_model: 'https://cdn/pbr.glb', model: 'https://cdn/model.glb' },
      })
    ).toBe('https://cdn/pbr.glb');
  });

  it('falls back through output.model and output.model_url', () => {
    expect(readModelUrl({ output: { model: 'https://cdn/model.glb' } })).toBe(
      'https://cdn/model.glb'
    );
    expect(readModelUrl({ output: { model_url: 'https://cdn/url.glb' } })).toBe(
      'https://cdn/url.glb'
    );
  });

  it('falls back to result.pbr_model and result.model', () => {
    expect(readModelUrl({ result: { pbr_model: 'https://cdn/r-pbr.glb' } })).toBe(
      'https://cdn/r-pbr.glb'
    );
    expect(readModelUrl({ result: { model: 'https://cdn/r-model.glb' } })).toBe(
      'https://cdn/r-model.glb'
    );
  });

  it('honours the documented precedence order', () => {
    expect(
      readModelUrl({
        output: { model_url: 'https://cdn/o-url.glb' },
        result: { pbr_model: 'https://cdn/r-pbr.glb' },
      })
    ).toBe('https://cdn/o-url.glb');
  });

  it('skips non-absolute or missing URLs', () => {
    expect(readModelUrl({ output: { pbr_model: 'relative/path.glb' } })).toBeNull();
    expect(readModelUrl({ output: {} })).toBeNull();
    expect(readModelUrl({})).toBeNull();
    expect(readModelUrl(null)).toBeNull();
  });
});

describe('classifyStatus', () => {
  it('classifies done statuses', () => {
    expect(classifyStatus('success')).toBe('done');
    expect(classifyStatus('succeeded')).toBe('done');
    expect(classifyStatus('SUCCESS')).toBe('done');
  });

  it('classifies failed statuses', () => {
    for (const status of ['failed', 'banned', 'cancelled', 'expired', 'unknown']) {
      expect(classifyStatus(status)).toBe('failed');
    }
  });

  it('classifies in-progress statuses', () => {
    for (const status of ['queued', 'running', 'pending', 'processing']) {
      expect(classifyStatus(status)).toBe('in-progress');
    }
  });

  it('treats unrecognized or non-string values as in-progress', () => {
    expect(classifyStatus('weird')).toBe('in-progress');
    expect(classifyStatus('')).toBe('in-progress');
    expect(classifyStatus(undefined)).toBe('in-progress');
    expect(classifyStatus(42)).toBe('in-progress');
  });
});

describe('fileTypeFromMime', () => {
  it('maps common image mime types', () => {
    expect(fileTypeFromMime('image/png')).toBe('png');
    expect(fileTypeFromMime('image/jpeg')).toBe('jpeg');
    expect(fileTypeFromMime('image/jpg')).toBe('jpg');
    expect(fileTypeFromMime('image/webp')).toBe('webp');
    expect(fileTypeFromMime('IMAGE/PNG')).toBe('png');
  });

  it('defaults unknown mime types to png', () => {
    expect(fileTypeFromMime('application/octet-stream')).toBe('png');
    expect(fileTypeFromMime('')).toBe('png');
  });
});

describe('readCode', () => {
  it('reads a numeric code and defaults a missing one to 0', () => {
    expect(readCode({ code: 2005 })).toBe(2005);
    expect(readCode({ code: 0 })).toBe(0);
    expect(readCode({})).toBe(0);
    expect(readCode(null)).toBe(0);
  });
});
