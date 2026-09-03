import { useEffect, useRef, useState } from 'react';
import { Slider, type SliderProps } from '@mui/material';

/**
 * A Slider that tracks the pointer while dragging and only calls `onCommit` on
 * release. MUI's Slider is fully controlled once `value` is set, so a controlled
 * slider with a no-op `onChange` freezes the thumb — this keeps local state.
 *
 * It re-syncs to the authoritative `value` prop when it changes, EXCEPT while
 * the user is dragging: realtime state pushes arrive ~1/s, and without the guard
 * a push carrying the pre-drag value would yank the thumb back mid-gesture.
 */
export function CommittedSlider({
  value,
  onCommit,
  formatValue,
  ...rest
}: {
  value: number;
  onCommit: (value: number) => void;
  formatValue?: (value: number) => string;
} & Omit<SliderProps, 'value' | 'onChange' | 'onChangeCommitted'>) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);

  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);

  return (
    <Slider
      {...rest}
      value={local}
      valueLabelFormat={formatValue}
      onChange={(_, v) => {
        dragging.current = true;
        setLocal(v as number);
      }}
      onChangeCommitted={(_, v) => {
        dragging.current = false;
        setLocal(v as number);
        onCommit(v as number);
      }}
    />
  );
}
