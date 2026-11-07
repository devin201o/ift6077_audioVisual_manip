// Types shared by main, preload and renderer (erased at build time).

/** Coarse 1-5 scale. All levels are LLM ESTIMATES, not measurements. */
export type Level = 1 | 2 | 3 | 4 | 5;

/** Everything here comes from the analyzer (LLM). Nothing is computed locally. */
export interface Descriptors {
  caption: string; // one literal line
  tags: string[];
  vibe: {
    summary: string;
    moods: string[]; // 3-5 words
    valence: Level; // 1 unpleasant .. 5 pleasant
    arousal: Level; // 1 calm .. 5 energetic
    tension: Level | null; // 1 relaxed .. 5 tense
  };
  visual: {
    estimated: true;
    palette: string[]; // ~5 #rrggbb, dominant first
    brightness: Level; contrast: Level; saturation: Level;
    warmth: Level; // 1 cool .. 5 warm
  };
  context: { caption: string; summary: string; moods: string[]; palette: string[] } | null; // objects only: the surrounding scene
}

export interface Chip {
  schema: 1;
  id: string; // sha256 hex of the content (see chips.ts)
  kind: 'object' | 'image' | 'clip';
  createdAt: string;
  source: {
    path: string | null; hash: string | null; name: string; media: 'image' | 'video';
    frameTime: number | null; // seconds, video frames only
    click: { x: number; y: number } | null; // 0-1 of the frame, object chips only
    w: number; h: number; // native frame size
  };
  object: { bbox: { x: number; y: number; w: number; h: number }; area: number } | null; // 0-1, from the SAM mask (provenance only)
  files: { thumb: string; cutout?: string; mask?: string; uploads: string[] }; // names inside library/<id>/
  analysis: {
    status: 'pending' | 'done' | 'failed' | 'needs-key';
    error?: string; network?: boolean; // network: failed only because we were offline/unreachable (retried when back online)
    analyzer: string; model?: string; version: number;
    at?: string; ms?: number; tokens?: { in: number; out: number }; cost?: number;
  };
  auto: Descriptors | null; // overwritten by (re)analysis
  user: { caption?: string; summary?: string; moods?: string[]; tags?: string[] }; // user edits, never overwritten
  motion: null; // reserved: dynamics of video-derived chips
  embedding: null | { model: string; dims: number; file: 'embedding.f32' }; // reserved: raw little-endian float32 sidecar
}

/** What the renderer sees: `missing` (source file gone) is computed on every list, never stored. */
export type ChipView = Chip & { missing: boolean };

/** Renderer -> main. Main hashes, dedupes and writes the files. */
export interface AddInput {
  kind: Chip['kind'];
  source: Omit<Chip['source'], 'hash'>; // main hashes the file
  object: Chip['object'];
  thumb: ArrayBuffer; // webp, 256px
  cutout?: ArrayBuffer; // png
  mask?: ArrayBuffer; // png, native res
  uploads: ArrayBuffer[]; // webp, long edge <= 1024: the images analysis will send (object chips: [object, scene])
}

/** Settings as the renderer sees them. The API key itself is never included. */
export interface SettingsView { model: string; hasKey: boolean; privacyAck: boolean; canEncrypt: boolean }
