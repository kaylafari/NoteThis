export {};

declare global {
  interface Window {
    desktop?: {
      readonly isElectron: true;
      readonly platform: string;
      readonly appVersion: string;
    };
  }
}
