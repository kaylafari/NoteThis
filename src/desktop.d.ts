export {};

declare global {
  interface Window {
    desktop?: {
      readonly isElectron: true;
      readonly platform: string;
      readonly appVersion: string;
      updates?: {
        state: () => Promise<import("../shared/updates").UpdateState>;
        action: (
          action: import("../shared/updates").UpdateAction,
        ) => Promise<import("../shared/updates").UpdateState>;
        subscribe: (
          callback: (state: import("../shared/updates").UpdateState) => void,
        ) => () => void;
      };
      openExternal: (
        url: string,
      ) => Promise<{ ok: true } | { ok: false; error: string }>;
    };
  }
}
