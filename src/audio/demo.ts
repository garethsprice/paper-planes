/** An original, locally synthesized 40-second sketch with a quiet lead-in and two arrivals. */
export function createDemoFile(): File {
  const rate = 22050, duration = 40, count = rate * duration;
  const bytes = new ArrayBuffer(44 + count * 2);
  const view = new DataView(bytes);
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, count * 2, true);
  const chords = [[130.81, 164.81, 196], [110, 130.81, 164.81], [87.31, 130.81, 174.61], [98, 146.83, 196]];
  let seed = 12345;
  for (let i = 0; i < count; i++) {
    const t = i / rate, phase = t % 16;
    const rise = Math.min(1, phase / 12);
    const gain = phase < 11.5 ? 0.10 + rise * 0.13 : phase < 12 ? 0.006 : 0.65;
    const chord = chords[Math.floor(t / 4) % chords.length];
    const beat = t % 0.5;
    let tone = 0;
    for (const hz of chord) tone += Math.sin(2 * Math.PI * hz * t) * 0.12;
    tone += Math.sin(2 * Math.PI * chord[Math.floor(t * 4) % 3] * 4 * t) * Math.exp(-(t % 0.25) * 15) * 0.2;
    tone += Math.sin(2 * Math.PI * (48 * beat + 8 * (1 - Math.exp(-beat * 25)))) * Math.exp(-beat * 18) * 0.5;
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    tone += (seed / 2147483648) * Math.exp(-(t % 0.25) * 100) * 0.08;
    const fade = Math.min(1, t, duration - t);
    view.setInt16(44 + i * 2, Math.tanh(tone * gain) * fade * 32767, true);
  }
  return new File([bytes], 'Paper Planes — first light.wav', { type: 'audio/wav' });
}
