// "Now playing" card: a vinyl disc with the song's cover as its label, spinning
// while a poster's song plays, plus title, artist, and a stop button ringed by
// the playback progress.
//
// The markup and styles live in Room.astro; this file only fills in text and
// flips one attribute. All motion is CSS:
//   • data-state="playing" → the card slides in and the disc spins
//     (an infinite CSS animation, paused in any other state);
//   • --p (0..1), set every frame from posters.ts → the ring's stroke offset.
// Setting one custom property per frame is cheap: it only repaints the small
// ring, with no layout work.
import type { PosterSong } from './posters';

export function createNowPlaying(root: HTMLElement, onStop: () => void) {
  const label = root.querySelector<HTMLImageElement>('.np-label')!;
  const title = root.querySelector<HTMLElement>('.np-title')!;
  const artist = root.querySelector<HTMLElement>('.np-artist')!;
  const stop = root.querySelector<HTMLButtonElement>('.np-stop')!;
  stop.addEventListener('click', onStop);

  return {
    show(song: PosterSong & { cover: string }) {
      label.src = song.cover;
      title.textContent = song.title;
      artist.textContent = song.artist ?? '';
      artist.hidden = !song.artist;
      root.style.setProperty('--p', '0');
      root.dataset.state = 'playing';
    },
    progress(fraction: number) {
      root.style.setProperty('--p', fraction.toFixed(4));
    },
    hide() {
      root.dataset.state = 'stopped'; // CSS fades it out and pauses the spin
    },
  };
}
