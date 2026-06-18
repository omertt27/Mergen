/**
 * routes/team-usage.ts — Team dashboard roll-up.
 *
 *   GET /team/usage
 *
 * Returns a single, joined view of:
 *   - RBAC members and their roles
 *   - Active PR authors this month (billing unit)
 *   - Habituation metrics (engineers engaging with Mergen PR comments)
 *   - Incident participation (who acknowledged/resolved incidents)
 *   - Seat utilization vs. plan
 *
 * Designed as the "team admin" page data source — one call renders the
 * whole team overview without multiple parallel requests.
 */

import { Router } from 'express';
import { listMembers } from '../sensor/rbac.js';
import { getWeeklyHabituation, getHabituationEvents } from '../sensor/habituation-store.js';
import { getActivePlanId } from '../intelligence/license.js';
import { getPlan } from '../intelligence/plans.js';
import { incidentStore } from '../sensor/incident-store.js';

export function createTeamUsageRouter(): Router {
  const router = Router();

  router.get('/team/usage', (_req, res) => {
    const members = listMembers();
    const planId  = getActivePlanId();
    const plan    = getPlan(planId);

    // Habituation — last 4 weeks
    const habWeekly = getWeeklyHabituation(4);
    const habEvents = getHabituationEvents();
    const commentors = new Set(habEvents.filter((e) => e.eventType === 'comment_posted').map((e) => e.actor));
    const engaged    = new Set(habEvents.filter((e) => e.eventType !== 'comment_posted').map((e) => e.actor));
    const habRate    = commentors.size > 0 ? engaged.size / commentors.size : null;

    // Recent incidents — who touched them
    const recentIncidents = incidentStore.list(undefined, 50);
    const acknowledgedBy  = new Set(recentIncidents.map((i) => (i as Record<string, unknown>).acknowledgedBy as string).filter(Boolean));
    const resolvedBy      = new Set(recentIncidents.map((i) => (i as Record<string, unknown>).resolvedBy as string).filter(Boolean));
    const activeResponders = new Set([...acknowledgedBy, ...resolvedBy]);

    // Seat utilization
    const adminCount    = members.filter((m) => m.role === 'admin').length;
    const responderCount = members.filter((m) => m.role === 'responder').length;
    const viewerCount   = members.filter((m) => m.role === 'viewer').length;

    // Per-member enrichment: active in incidents or habituation
    const enrichedMembers = members.map((m) => ({
      ...m,
      activeInIncidents: activeResponders.has(m.id),
      activeInHabituation: commentors.has(m.id) || engaged.has(m.id),
    }));

    res.json({
      ok: true,
      plan: {
        id:     plan.id,
        name:   plan.name,
        seats:  plan.seats,
        ctaUrl: plan.ctaUrl,
      },
      members: {
        total:     members.length,
        admins:    adminCount,
        responders: responderCount,
        viewers:   viewerCount,
        list:      enrichedMembers,
      },
      habituation: {
        windowWeeks:          4,
        totalPRsCommented:    habEvents.filter((e) => e.eventType === 'comment_posted').length,
        uniqueEngineers:      new Set(habEvents.map((e) => e.actor)).size,
        engineersWithComments: commentors.size,
        engagedEngineers:     engaged.size,
        habituationRate:      habRate,
        habituationRateLabel: habRate !== null ? `${Math.round(habRate * 100)}%` : null,
        weekly:               habWeekly,
      },
      incidentParticipation: {
        activeResponders:   activeResponders.size,
        acknowledgedBy:     [...acknowledgedBy],
        resolvedBy:         [...resolvedBy],
        recentIncidents:    recentIncidents.length,
      },
      addMemberHint: members.length === 0
        ? 'No team members configured. Add via: POST /rbac/members { id, role }'
        : null,
    });
  });

  return router;
}
