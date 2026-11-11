export type UpdateState = {
  currentVersion: string;
  status:
    | "idle"
    | "checking"
    | "up-to-date"
    | "available"
    | "downloading"
    | "ready"
    | "restarting"
    | "error"
    | "unavailable";
  version?: string;
  native?: boolean;
  error?: string;
};
export type UpdateAction = "check" | "download" | "restart" | "installer";
