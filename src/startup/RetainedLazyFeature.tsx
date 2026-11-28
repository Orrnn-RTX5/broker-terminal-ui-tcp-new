import { Suspense, useEffect, useState, type ReactNode } from 'react';

/** Download a closed feature on first use, then keep its existing local state. */
export function RetainedLazyFeature({ active, children }: { active: boolean; children: ReactNode }) {
  const [hasOpened, setHasOpened] = useState(active);
  useEffect(() => {
    if (active) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- latches first active open post-commit so closing keeps lazy subtree mounted without changing render timing
      setHasOpened(true);
    }
  }, [active]);
  if (!active && !hasOpened) return null;
  return <Suspense fallback={null}>{children}</Suspense>;
}
