import { createHmac, randomBytes } from 'node:crypto';
import {
  createExperiment,
  db,
  getExperimentManifest,
  syncExperimentPlacements,
  transitionExperiment,
  updateExperiment,
} from '@openpanel/db';
import {
  zExperimentCreate,
  zExperimentPlacement,
  zExperimentUpdate,
} from '@openpanel/validation';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '@/utils/errors';

const manifestQuery = z.object({
  site: z.string().min(1).max(80),
  environment: z.string().min(1).max(80),
});
const placementsBody = z.object({
  placements: z.array(z.record(z.string(), z.unknown())).max(500),
});

function actor(request: FastifyRequest) {
  return String(request.headers['x-bcm-actor'] || 'wordpress-service')
    .replace(/[^a-zA-Z0-9@_.:-]/g, '_')
    .slice(0, 160);
}

function authorizedSites(request: FastifyRequest) {
  return String(request.headers['x-bcm-authorized-sites'] || '')
    .split(',')
    .filter(Boolean);
}

function assertSites(request: FastifyRequest, sites: string[]) {
  const allowed = authorizedSites(request);
  if (!allowed.includes('*') && sites.some((site) => !allowed.includes(site))) {
    throw new HttpError('Service token is not authorized for this site', {
      status: 403,
    });
  }
}

async function assertExperimentAccess(request: FastifyRequest, id: string) {
  const experiment = await db.experiment.findUnique({
    where: { id },
    select: { sites: true },
  });
  if (!experiment) {
    throw new HttpError('Experiment not found', { status: 404 });
  }
  assertSites(request, experiment.sites);
}

function normalizeCreate(body: Record<string, unknown>, owner: string) {
  return zExperimentCreate.parse({
    ...body,
    owner,
    assignmentSalt:
      body.assignmentSalt ||
      body.assignment_salt ||
      randomBytes(24).toString('hex'),
    primaryEvent: body.primaryEvent || body.primary_event,
    secondaryEvents: body.secondaryEvents || body.secondary_events || [],
    guardrailEvents: body.guardrailEvents || body.guardrail_events || [],
    exclusionGroup: body.exclusionGroup || body.exclusion_group || null,
    startsAt: body.startsAt || body.starts_at || null,
    stopsAt: body.stopsAt || body.stops_at || null,
    patches: body.patches || [],
  });
}

function normalizeUpdate(body: Record<string, unknown>) {
  return zExperimentUpdate.parse({
    ...body,
    primaryEvent: body.primaryEvent || body.primary_event,
    secondaryEvents: body.secondaryEvents || body.secondary_events,
    guardrailEvents: body.guardrailEvents || body.guardrail_events,
    exclusionGroup: body.exclusionGroup || body.exclusion_group,
    assignmentSalt: body.assignmentSalt || body.assignment_salt,
    startsAt: body.startsAt || body.starts_at,
    stopsAt: body.stopsAt || body.stops_at,
  });
}

export async function list(request: FastifyRequest) {
  const sites = authorizedSites(request);
  return db.experiment.findMany({
    where: sites.includes('*') ? undefined : { sites: { hasSome: sites } },
    include: { audit: { orderBy: { createdAt: 'desc' }, take: 20 } },
    orderBy: { updatedAt: 'desc' },
  });
}

export async function create(request: FastifyRequest) {
  const requestActor = actor(request);
  const input = normalizeCreate(
    request.body as Record<string, unknown>,
    requestActor
  );
  assertSites(request, input.sites);
  return createExperiment(input, requestActor, 'service-api');
}

export async function update(request: FastifyRequest) {
  const { id } = request.params as { id: string };
  const input = normalizeUpdate(request.body as Record<string, unknown>);
  await assertExperimentAccess(request, id);
  if (input.sites) {
    assertSites(request, input.sites);
  }
  try {
    return await updateExperiment(id, input, actor(request), 'service-api');
  } catch (error) {
    throw new HttpError(
      error instanceof Error ? error.message : 'Experiment update failed',
      { status: 409, error }
    );
  }
}

export async function transition(request: FastifyRequest) {
  const { id, action } = request.params as { id: string; action: string };
  const requestId = String(request.headers['idempotency-key'] || '');
  if (!requestId || requestId.length > 160) {
    throw new HttpError('A valid Idempotency-Key header is required', {
      status: 400,
    });
  }
  await assertExperimentAccess(request, id);
  try {
    return await transitionExperiment(
      id,
      action,
      actor(request),
      'service-api',
      requestId
    );
  } catch (error) {
    throw new HttpError(
      error instanceof Error ? error.message : 'Lifecycle transition failed',
      {
        status: 409,
        error,
      }
    );
  }
}

export async function placements(request: FastifyRequest) {
  const body = placementsBody.parse(request.body);
  const defaults = request.body as { site?: string; environment?: string };
  const normalized = body.placements.map((placement) =>
    zExperimentPlacement.parse({
      ...placement,
      site: placement.site || defaults.site,
      environment: placement.environment || defaults.environment,
      slot: placement.slot || placement.key,
      metadata: {
        style_tokens: placement.style_tokens || [],
        ...(typeof placement.metadata === 'object' ? placement.metadata : {}),
      },
    })
  );
  assertSites(
    request,
    normalized.map((placement) => placement.site)
  );
  return syncExperimentPlacements(normalized);
}

export async function manifest(request: FastifyRequest, reply: FastifyReply) {
  const query = manifestQuery.parse(request.query);
  assertSites(request, [query.site]);
  const result = await getExperimentManifest(query.site, query.environment);
  if (request.headers['if-none-match'] === result.etag) {
    return reply.status(304).send();
  }
  const signingKey = process.env.BCM_EXPERIMENTS_SIGNING_KEY;
  if (!signingKey) {
    throw new Error('BCM_EXPERIMENTS_SIGNING_KEY is not configured');
  }
  const signature = createHmac('sha256', signingKey)
    .update(result.body)
    .digest('hex');
  return reply
    .header('Content-Type', 'application/json')
    .header('Cache-Control', 'private, max-age=60, stale-if-error=240')
    .header('ETag', result.etag)
    .header('X-BCM-Signature', `sha256=${signature}`)
    .send(result.manifest);
}

export async function audit(request: FastifyRequest) {
  const { id } = request.params as { id: string };
  await assertExperimentAccess(request, id);
  return db.experimentAudit.findMany({
    where: { experimentId: id },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
}

export async function health() {
  await db.experiment.count();
  return {
    status: 'ok',
    service: 'bcm-experiments',
    time: new Date().toISOString(),
  };
}
