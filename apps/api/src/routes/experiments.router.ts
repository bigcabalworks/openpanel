import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZodOpenApi } from 'fastify-zod-openapi';
import { z } from 'zod';
import * as controller from '@/controllers/experiments.controller';
import { activateRateLimiter } from '@/utils/rate-limiter';

const idParams = z.object({ id: z.string().uuid() });
const transitionParams = idParams.extend({
  action: z.enum(['start', 'pause', 'stop', 'archive']),
});

function authorizedSites(request: FastifyRequest): string[] | null {
  const supplied = String(request.headers.authorization || '').replace(
    /^Bearer\s+/i,
    ''
  );
  let siteTokens: Record<string, string> = {};
  try {
    siteTokens = JSON.parse(
      process.env.BCM_EXPERIMENTS_SERVICE_TOKENS_JSON || '{}'
    );
  } catch {
    siteTokens = {};
  }
  const matchedSites = Object.entries(siteTokens)
    .filter(
      ([, token]) =>
        token.length === supplied.length &&
        timingSafeEqual(Buffer.from(token), Buffer.from(supplied))
    )
    .map(([site]) => site);
  if (matchedSites.length) {
    return matchedSites;
  }

  if (process.env.BCM_EXPERIMENTS_ALLOW_GLOBAL_TOKEN !== 'true') {
    return null;
  }

  const legacyTokens = [
    ...(process.env.BCM_EXPERIMENTS_SERVICE_TOKENS || '').split(','),
    process.env.BCM_EXPERIMENTS_SERVICE_TOKEN || '',
  ]
    .map((token) => token.trim())
    .filter(Boolean);
  return legacyTokens.some(
    (token) =>
      token.length === supplied.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(supplied))
  )
    ? ['*']
    : null;
}

const experimentsRouter: FastifyPluginAsyncZodOpenApi = async (fastify) => {
  await activateRateLimiter({
    fastify,
    max: Number.parseInt(
      process.env.BCM_EXPERIMENTS_RATE_LIMIT_MAX || '60',
      10
    ),
    timeWindow: '1 minute',
  });
  fastify.addHook('preHandler', async (request, reply) => {
    const sites = authorizedSites(request);
    if (!sites) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid experiment service token',
      });
    }
    request.headers['x-bcm-authorized-sites'] = sites.join(',');
  });

  fastify.get(
    '/health',
    { schema: { tags: ['Experiments'] } },
    controller.health
  );
  fastify.get(
    '/manifest',
    { schema: { tags: ['Experiments'] } },
    controller.manifest
  );
  fastify.get('', { schema: { tags: ['Experiments'] } }, controller.list);
  fastify.post('', { schema: { tags: ['Experiments'] } }, controller.create);
  fastify.patch(
    '/:id',
    { schema: { params: idParams, tags: ['Experiments'] } },
    controller.update
  );
  fastify.post(
    '/:id/:action',
    { schema: { params: transitionParams, tags: ['Experiments'] } },
    controller.transition
  );
  fastify.put(
    '/placements',
    { schema: { tags: ['Experiments'] } },
    controller.placements
  );
  fastify.get(
    '/:id/audit',
    { schema: { params: idParams, tags: ['Experiments'] } },
    controller.audit
  );
};

export default experimentsRouter;
