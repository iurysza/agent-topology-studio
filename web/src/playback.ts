// Run playback as a small state machine: where the scrubber sits and whether it is playing. Pure, so the
// transport's rules are tested without a browser. A tick moves one step; at the last step playing stops.
export const TICK_MS = 800;
export interface Play { at: number; playing: boolean }
export type PlayAction =
  | { t: "toggle"; last: number }
  | { t: "tick"; last: number }
  | { t: "step"; by: -1 | 1; last: number }
  | { t: "seek"; to: number; last: number }
  | { t: "pause" };

const clamp = (n: number, last: number) => Math.max(0, Math.min(n, last));

export function playback(s: Play, a: PlayAction): Play {
  switch (a.t) {
    // Play from the end starts over; there is nothing left to show from there.
    case "toggle": return s.playing ? { ...s, playing: false } : { at: s.at >= a.last ? 0 : s.at, playing: a.last > 0 };
    case "tick": { if (!s.playing) return s; const at = clamp(s.at + 1, a.last); return { at, playing: at < a.last }; }
    // A step or a seek while playing pauses: the person has taken the wheel.
    case "step": return { at: clamp(s.at + a.by, a.last), playing: false };
    case "seek": return { at: clamp(a.to, a.last), playing: false };
    case "pause": return s.playing ? { ...s, playing: false } : s;
  }
}
