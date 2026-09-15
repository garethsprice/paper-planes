export type LyricLine = { time: number; text: string };
export function parseLrc(text: string): LyricLine[] {
  const offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] ?? 0) / 1000;
  const lines: LyricLine[] = [];
  for (const line of text.split(/\r?\n/)) {
    const content = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!content) continue;
    for (const match of line.matchAll(/\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]/g)) {
      if (Number(match[2]) >= 60) continue;
      const fraction = match[3] ? Number('0.' + match[3]) : 0;
      lines.push({ time: Math.max(0, Number(match[1]) * 60 + Number(match[2]) + fraction + offset), text: content.slice(0, 240) });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}
export function lyricAt(lines: LyricLine[], time: number): number {
  let lo = 0, hi = lines.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (lines[mid].time <= time) lo = mid + 1; else hi = mid; }
  return lo - 1;
}
