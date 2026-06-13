export interface ErrorFrequencyEntry {
  count:       number;
  firstSeen:   number;
  lastSeen:    number;
  sample:      string;
  fingerprint: string;
  isNew:       boolean;
  [key: string]: unknown;
}

export interface NetworkFrequencyEntry {
  count:  number;
  sample: string;
  [key: string]: unknown;
}

export declare function computeErrorFrequency(...args: unknown[]): ErrorFrequencyEntry[];
export declare function computeNetworkFrequency(...args: unknown[]): NetworkFrequencyEntry[];
export declare function normaliseMessage(msg: string): string;