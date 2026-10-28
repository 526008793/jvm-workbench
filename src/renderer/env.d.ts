import type { DesktopApi } from '../shared/models';

declare global {
  interface Window {
    tracelogdock: DesktopApi;
  }
}
export {};
