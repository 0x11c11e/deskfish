'use client';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Fixed values keep the server render and hydration identical, with no animation timers.
const bubbles = [
  [3, 19, 24, -7, 30],
  [9, 42, 30, -20, -28],
  [15, 12, 19, -13, 45],
  [22, 28, 27, -4, -36],
  [28, 15, 22, -18, 24],
  [35, 48, 34, -26, -32],
  [41, 10, 18, -6, 38],
  [47, 24, 29, -16, -26],
  [54, 16, 23, -10, 42],
  [61, 36, 32, -24, -35],
  [67, 11, 20, -2, 28],
  [73, 26, 26, -19, -42],
  [79, 14, 21, -11, 30],
  [85, 52, 35, -8, -25],
  [91, 21, 25, -22, 32],
  [97, 32, 31, -15, -30],
  [6, 9, 17, -14, 22],
  [94, 12, 19, -5, -24],
];

export function BackgroundBubbles() {
  const [paused, setPaused] = useState(false);
  const field = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function syncVisibility() {
      if (field.current) field.current.dataset.hidden = String(document.hidden);
    }
    syncVisibility();
    document.addEventListener('visibilitychange', syncVisibility);
    return () =>
      document.removeEventListener('visibilitychange', syncVisibility);
  }, []);

  return (
    <>
      <div
        className="bubble-field"
        ref={field}
        data-paused={paused}
        aria-hidden="true"
      >
        {bubbles.map(([x, size, duration, delay, drift], index) => (
          <span
            key={x}
            className="bubble-rise"
            style={
              {
                '--bubble-x': `${x}%`,
                '--bubble-size': `${size}px`,
                '--bubble-duration': `${duration}s`,
                '--bubble-delay': `${delay}s`,
                '--bubble-drift': `${drift}px`,
                '--bubble-sway': `${3 + (index % 4)}s`,
              } as CSSProperties
            }
          >
            <i className="bubble-orb" />
          </span>
        ))}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="bubble-control"
        aria-label={
          paused ? 'Resume background bubbles' : 'Pause background bubbles'
        }
        title={paused ? 'Resume bubbles' : 'Pause bubbles'}
        onClick={() => setPaused(!paused)}
      >
        {paused ? <Play size={14} /> : <Pause size={14} />}
      </Button>
    </>
  );
}
