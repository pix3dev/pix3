export interface AudioPreviewAnalysis {
  readonly waveformUrl: string | null;
  readonly durationSeconds: number | null;
  readonly channelCount: number | null;
  readonly sampleRate: number | null;
}

interface AudioContextLike {
  decodeAudioData(audioData: ArrayBuffer): Promise<AudioBuffer>;
}

interface AudioContextConstructorLike {
  new (): AudioContextLike;
}

interface GlobalAudioContextWindow {
  AudioContext?: AudioContextConstructorLike;
  webkitAudioContext?: AudioContextConstructorLike;
}

export async function analyzeAudioBlob(blob: Blob): Promise<AudioPreviewAnalysis> {
  const audioContext = getAudioContext();
  if (!audioContext) {
    return {
      waveformUrl: null,
      durationSeconds: null,
      channelCount: null,
      sampleRate: null,
    };
  }

  try {
    const audioBuffer = await audioContext.decodeAudioData(await blob.arrayBuffer());
    return {
      waveformUrl: buildWaveformSvgDataUrl(audioBuffer),
      durationSeconds: Number.isFinite(audioBuffer.duration) ? audioBuffer.duration : null,
      channelCount: audioBuffer.numberOfChannels || null,
      sampleRate: audioBuffer.sampleRate || null,
    };
  } catch {
    return {
      waveformUrl: null,
      durationSeconds: null,
      channelCount: null,
      sampleRate: null,
    };
  }
}

function getAudioContext(): AudioContextLike | null {
  const audioGlobal = globalThis as typeof globalThis & GlobalAudioContextWindow;
  const AudioContextCtor = audioGlobal.AudioContext ?? audioGlobal.webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }

  try {
    return new AudioContextCtor();
  } catch {
    return null;
  }
}

function buildWaveformSvgDataUrl(audioBuffer: AudioBuffer): string {
  const width = 320;
  const height = 88;
  const bars = 56;
  const amplitudes = sampleWaveAmplitudes(audioBuffer, bars);
  const barWidth = width / bars;
  const barsSvg = amplitudes
    .map((amplitude, index) => {
      const clamped = clamp(amplitude, 0, 1);
      const barHeight = Math.max(4, clamped * (height - 18));
      const x = index * barWidth + 1;
      const y = (height - barHeight) / 2;
      return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${Math.max(
        2,
        barWidth - 2
      ).toFixed(2)}" height="${barHeight.toFixed(2)}" rx="1.5" fill="#ffc933" />`;
    })
    .join('');

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Audio waveform">`,
    '<defs>',
    '  <linearGradient id="wave-bg" x1="0" y1="0" x2="1" y2="1">',
    '    <stop offset="0%" stop-color="#18181b" />',
    '    <stop offset="100%" stop-color="#27272a" />',
    '  </linearGradient>',
    '</defs>',
    `<rect width="${width}" height="${height}" rx="10" fill="url(#wave-bg)" />`,
    `<path d="M12 ${height / 2} H ${width - 12}" stroke="#3f3f46" stroke-width="1" stroke-dasharray="4 4" />`,
    barsSvg,
    '</svg>',
  ].join('');

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function sampleWaveAmplitudes(audioBuffer: AudioBuffer, buckets: number): number[] {
  const channelData = collectChannelPeaks(audioBuffer);
  if (channelData.length === 0) {
    return Array.from({ length: buckets }, () => 0);
  }

  const bucketSize = Math.max(1, Math.floor(channelData.length / buckets));
  const amplitudes: number[] = [];

  for (let bucketIndex = 0; bucketIndex < buckets; bucketIndex += 1) {
    const start = bucketIndex * bucketSize;
    const end = bucketIndex === buckets - 1 ? channelData.length : start + bucketSize;
    let peak = 0;
    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      peak = Math.max(peak, Math.abs(channelData[sampleIndex] ?? 0));
    }
    amplitudes.push(peak);
  }

  return amplitudes;
}

function collectChannelPeaks(audioBuffer: AudioBuffer): Float32Array {
  if (audioBuffer.numberOfChannels <= 0) {
    return new Float32Array(0);
  }

  const reference = audioBuffer.getChannelData(0);
  const peaks = new Float32Array(reference.length);

  for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
    const data = audioBuffer.getChannelData(channelIndex);
    for (let sampleIndex = 0; sampleIndex < data.length; sampleIndex += 1) {
      const value = Math.abs(data[sampleIndex] ?? 0);
      if (value > peaks[sampleIndex]) {
        peaks[sampleIndex] = value;
      }
    }
  }

  return peaks;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
