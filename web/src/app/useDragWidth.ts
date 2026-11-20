import { type MouseEvent, useState } from 'react';

/**
 * A width the user can drag between `min` and `max`.
 * @returns the width and a mousedown handler for the splitter
 */
export function useDragWidth(initial: number, min: number, max: number): [number, (event: MouseEvent) => void] {
  const [width, setWidth] = useState(initial);
  const startDrag = (event: MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const onMove = (e: globalThis.MouseEvent) => setWidth(Math.min(max, Math.max(min, startWidth + e.clientX - startX)));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };
  return [width, startDrag];
}
