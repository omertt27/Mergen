export declare const hypothesisHistory: {
  list(): unknown[];
  latest(): unknown | null;
  clear(): void;
  notifyError(pid: string, err: unknown): void;
  add(entry: unknown): void;
};