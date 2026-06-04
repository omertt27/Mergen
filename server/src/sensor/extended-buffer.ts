import { z } from 'zod';
import type { ConsoleEvent, NetworkEvent, ContextSnapshot } from './buffer.js';

// ── Layer 1: Better Context — Extended event schemas ──────────────────────────

export const ComponentTreeNodeSchema: z.ZodType<any> = z.object({
  name: z.string(),
  type: z.string(), // 'React' | 'Vue' | 'Vue3'
  props: z.record(z.unknown()).optional(),
  state: z.record(z.unknown()).optional(),
  children: z.array(z.lazy(() => ComponentTreeNodeSchema)).optional(),
});

export const StateDiffSchema = z.object({
  framework: z.string(), // 'Redux' | 'Zustand' | 'Jotai' | 'MobX'
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  field: z.string().optional(),
  timestamp: z.number(),
});

export const PerformanceTraceSchema = z.object({
  entryType: z.string(), // 'long-task' | 'layout-shift' | 'paint' | 'navigation'
  name: z.string(),
  startTime: z.number(),
  duration: z.number(),
  metadata: z.record(z.unknown()).optional(),
});

export const ExtendedContextSnapshotSchema = z.object({
  type: z.literal('context'),
  trigger: z.enum(['error', 'warn', 'pageload', 'hmr', 'baseline', 'manual']),
  timestamp: z.number(),
  url: z.string(),
  title: z.string(),
  activeElement: z.string().optional(),
  component: z.string().optional(),
  localStorage: z.record(z.string()).default({}),
  sessionStorage: z.record(z.string()).default({}),
  // Layer 1 extensions
  componentTree: ComponentTreeNodeSchema.optional(),
  stateDiff: StateDiffSchema.optional(),
  performanceTrace: z.array(PerformanceTraceSchema).optional(),
});

export type ComponentTreeNode = z.infer<typeof ComponentTreeNodeSchema>;
export type StateDiff = z.infer<typeof StateDiffSchema>;
export type PerformanceTrace = z.infer<typeof PerformanceTraceSchema>;
export type ExtendedContextSnapshot = z.infer<typeof ExtendedContextSnapshotSchema>;

// ── Layer 2: Better Diagnosis — Event replay and timeline ─────────────────────

export interface ReplayEvent {
  id: string;
  event: any; // Full original event
  timestamp: number;
  type: string;
}

export interface WatchPattern {
  id: string;
  pattern: string; // URL pattern, error message regex, etc.
  type: 'network' | 'console' | 'state';
  createdAt: number;
}

export interface TimelineEntry {
  timestamp: number;
  type: string;
  summary: string;
  fullEvent: any;
}

// ── Layer 3: Better Action — Breakpoints and mocks ────────────────────────────

export interface Breakpoint {
  id: string;
  condition: string;
  eventType: 'network' | 'console' | 'state';
  pattern: string; // URL, error message, state path
  createdAt: number;
  hitCount: number;
  capturedState?: any;
}

export interface MockResponse {
  id: string;
  url: string;
  method: string;
  status: number;
  body: any;
  headers?: Record<string, string>;
  createdAt: number;
  hitCount: number;
}

export interface InjectedLog {
  id: string;
  selector: string;
  event: string; // DOM event name
  expression: string; // JS expression to evaluate
  createdAt: number;
  captured: any[];
}

// ── Snapshot debugging ────────────────────────────────────────────────────────
// A DiagnosticSnapshot is captured when a breakpoint is hit. It bundles the
// triggering event with surrounding context so developers can replay offline.

export interface DiagnosticSnapshot {
  id: string;
  capturedAt: number;
  trigger: {
    breakpointId: string;
    eventType: string;
    summary: string;
  };
  recentLogs:      ConsoleEvent[];
  recentNetwork:   NetworkEvent[];
  contextSnapshot: ContextSnapshot | null;
  stack: string | undefined;
}

// ── Layer 4: Better Memory — Error history and fix linking ────────────────────

export interface ErrorHistoryEntry {
  fingerprint: string; // hash(error message + stack first 3 lines)
  message: string;
  stack?: string;
  count: number;
  firstSeen: number;
  lastSeen: number,
  fixes: FixLink[];
}

export interface FixLink {
  commitSha: string;
  description: string;
  linkedAt: number;
  verdict: 'correct' | 'partial' | 'wrong';
  confidence: number;
}
