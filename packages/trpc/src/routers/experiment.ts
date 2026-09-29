import { randomBytes, randomUUID } from 'node:crypto';
import {
  createExperiment,
  db,
  transitionExperiment,
  updateExperiment,
} from '@openpanel/db';
import { zExperimentUiCreate, zExperimentUpdate } from '@openpanel/validation';
import { z } from 'zod';
import { createTRPCRouter, protectedProcedure } from '../trpc';

export const experimentRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ projectId: z.string() }))
    .query(() =>
      db.experiment.findMany({
        include: { audit: { orderBy: { createdAt: 'desc' }, take: 5 } },
        orderBy: { updatedAt: 'desc' },
      })
    ),

  create: protectedProcedure
    .input(z.object({ projectId: z.string(), experiment: zExperimentUiCreate }))
    .mutation(({ input, ctx }) =>
      createExperiment(
        {
          ...input.experiment,
          owner: ctx.session.userId!,
          assignmentSalt: randomBytes(24).toString('hex'),
        },
        ctx.session.userId!,
        'openpanel-ui'
      )
    ),

  update: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        id: z.string().uuid(),
        experiment: zExperimentUpdate,
      })
    )
    .mutation(({ input, ctx }) =>
      updateExperiment(
        input.id,
        input.experiment,
        ctx.session.userId!,
        'openpanel-ui'
      )
    ),

  transition: protectedProcedure
    .input(
      z.object({
        projectId: z.string(),
        id: z.string().uuid(),
        action: z.enum(['start', 'pause', 'stop', 'archive']),
      })
    )
    .mutation(({ input, ctx }) =>
      transitionExperiment(
        input.id,
        input.action,
        ctx.session.userId!,
        'openpanel-ui',
        randomUUID()
      )
    ),

  audit: protectedProcedure
    .input(z.object({ projectId: z.string(), id: z.string().uuid() }))
    .query(({ input }) =>
      db.experimentAudit.findMany({
        where: { experimentId: input.id },
        orderBy: { createdAt: 'desc' },
        take: 200,
      })
    ),
});
