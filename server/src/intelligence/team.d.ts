import type { Router } from 'express';
export declare const teamRouter: Router;
export declare function getTeamState(): Record<string, unknown>;
export declare function isTeamEnabled(): boolean;
export declare function initTeam(): Promise<void>;
export declare function broadcastToTeam(msg: unknown): void;