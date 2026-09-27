import { create } from 'zustand';
import type { PairState } from '@/services/homebase/immersion/types';

interface ImmersionState {
  pairByHash: Record<string, PairState>;
  sheet: { open: boolean; tab: 'find' | 'requests'; query: string };
  setPairs: (map: Record<string, PairState>) => void;
  openSheet: (tab: 'find' | 'requests', query?: string) => void;
  closeSheet: () => void;
}

export const useImmersionStore = create<ImmersionState>((set) => ({
  pairByHash: {},
  sheet: { open: false, tab: 'find', query: '' },
  setPairs: (pairByHash) => set({ pairByHash }),
  openSheet: (tab, query) =>
    set((state) => ({ sheet: { open: true, tab, query: query ?? state.sheet.query } })),
  closeSheet: () => set((state) => ({ sheet: { ...state.sheet, open: false } })),
}));
