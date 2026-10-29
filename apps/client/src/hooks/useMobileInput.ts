import { useMediaQuery } from './useMediaQuery';

/** Keep Enter available for newlines on phones, including landscape, and tablets. */
export function useMobileInput(): boolean {
  return useMediaQuery('(max-width: 767px), (pointer: coarse)');
}
