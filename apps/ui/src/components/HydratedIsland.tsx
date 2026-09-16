import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';
import { QueryClientProvider, HydrationBoundary, type DehydratedState } from '@tanstack/react-query';
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import { createBrowserQueryClient, getBrowserQueryClient } from '../lib/query/client';

export interface HydratedIslandProps {
  children: ReactNode;
  dehydratedState?: DehydratedState;
}

// Independent Astro roots can finish loading in any order. Keep SSG and the
// first browser render identical even when a sibling already filled the cache.
const IslandHydrationContext = createContext(false);
export function useIslandHydrated(): boolean {
  return useContext(IslandHydrationContext);
}

type ThemeMode = 'light' | 'dark';

function readThemeMode(): ThemeMode {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/**
 * Shared provider for every page island. Spargax themes the Astryx components; the
 * observer keeps independently hydrated Astro islands on the same light/dark
 * mode when the global theme toggle updates <html>.
 */
export function HydratedIsland({ children, dehydratedState }: HydratedIslandProps) {
  const client =
    typeof window === 'undefined' ? createBrowserQueryClient() : getBrowserQueryClient();
  const [mode, setMode] = useState<ThemeMode>(() => readThemeMode());
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setMode(readThemeMode()));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return (
    <div data-vf-hydrated={hydrated ? 'true' : 'false'} style={{ display: 'contents' }}>
      <Theme theme={neutralTheme} mode={mode}>
        <QueryClientProvider client={client}>
          <IslandHydrationContext.Provider value={hydrated}>
            <HydrationBoundary state={dehydratedState}>{children}</HydrationBoundary>
          </IslandHydrationContext.Provider>
        </QueryClientProvider>
      </Theme>
    </div>
  );
}
