import { useState, useEffect, useCallback, useRef } from 'preact/hooks';

const MERGED_COUNT_KEY = 'oss-autopilot-merged-count';
export const CELEBRATIONS_KEY = 'oss-autopilot-celebrations';
const AUTO_DISMISS_MS = 5_000;

export function useCelebration(mergedCount: number | undefined) {
  const [newMergeCount, setNewMergeCount] = useState<number | null>(null);
  const checkedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (mergedCount === undefined || checkedRef.current) return;
    checkedRef.current = true;

    try {
      const enabled = localStorage.getItem(CELEBRATIONS_KEY) !== 'false';
      const prev = localStorage.getItem(MERGED_COUNT_KEY);
      localStorage.setItem(MERGED_COUNT_KEY, String(mergedCount));

      if (prev !== null && enabled) {
        const delta = mergedCount - Number(prev);
        if (delta > 0) {
          setNewMergeCount(delta);
          timerRef.current = setTimeout(() => setNewMergeCount(null), AUTO_DISMISS_MS);
        }
      }
    } catch (err) {
      console.warn('[useCelebration] localStorage unavailable, skipping celebration check:', err);
    }
  }, [mergedCount]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const dismiss = useCallback(() => {
    setNewMergeCount(null);
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { celebrating: newMergeCount !== null, newMergeCount, dismiss };
}
