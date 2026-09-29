import { createHash, createHmac, randomUUID } from 'node:crypto';
import { db, type ExperimentStatus, type Prisma } from '../prisma-client';

interface ExperimentInput {
  key: string;
  name: string;
  slot: string;
  owner: string;
  sites: string[];
  environments: string[];
  startsAt?: Date | null;
  stopsAt?: Date | null;
  allocation: number;
  variants: unknown[];
  targeting: unknown[];
  patches: unknown[];
  primaryEvent: string;
  secondaryEvents: string[];
  guardrailEvents: string[];
  exclusionGroup?: string | null;
  assignmentSalt: string;
}

type ExperimentTx = Pick<
  typeof db,
  | 'experiment'
  | 'experimentAudit'
  | 'experimentLifecycleRequest'
  | 'experimentManifestRevision'
  | 'experimentPlacement'
>;

const uniqueTargets = (sites: string[], environments: string[]) =>
  sites.flatMap((site) =>
    environments.map((environment) => ({ site, environment }))
  );

function assertExperimentShape(input: {
  startsAt?: Date | null;
  stopsAt?: Date | null;
  variants: unknown;
  patches: unknown;
}) {
  if (input.startsAt && input.stopsAt && input.stopsAt <= input.startsAt) {
    throw new Error('Stop time must be after start time');
  }

  if (!Array.isArray(input.variants)) {
    throw new Error('Experiment variants must be an array');
  }
  const variants = input.variants as Array<{ key?: unknown; weight?: unknown }>;
  const variantKeys = variants.map((variant) => variant.key);
  if (
    variants.length < 2 ||
    variants.length > 10 ||
    variantKeys.some((key) => typeof key !== 'string') ||
    new Set(variantKeys).size !== variantKeys.length ||
    !variantKeys.includes('control') ||
    variants.some(
      (variant) =>
        typeof variant.weight !== 'number' ||
        !Number.isFinite(variant.weight) ||
        variant.weight <= 0
    )
  ) {
    throw new Error(
      'Variants must have unique keys, positive weights, and include control'
    );
  }

  if (!Array.isArray(input.patches)) {
    throw new Error('Experiment patches must be an array');
  }
  for (const patch of input.patches as Array<{ variant?: unknown }>) {
    if (!variantKeys.includes(patch.variant)) {
      throw new Error(`Unknown patch variant: ${String(patch.variant)}`);
    }
  }
}

async function incrementManifestRevisions(
  tx: ExperimentTx,
  targets: Array<{ site: string; environment: string }>
) {
  await Promise.all(
    targets.map(({ site, environment }) =>
      tx.experimentManifestRevision.upsert({
        where: { site_environment: { site, environment } },
        create: { site, environment, revision: 1 },
        update: { revision: { increment: 1 } },
      })
    )
  );
}

export async function createExperiment(
  input: ExperimentInput,
  actor: string,
  source: string
) {
  assertExperimentShape(input);
  return db.$transaction(async (tx) => {
    const experiment = await tx.experiment.create({
      data: {
        ...input,
        variants: input.variants as Prisma.InputJsonValue,
        targeting: input.targeting as Prisma.InputJsonValue,
        patches: input.patches as Prisma.InputJsonValue,
      },
    });
    await tx.experimentAudit.create({
      data: {
        experimentId: experiment.id,
        action: 'create',
        actor,
        source,
        revision: experiment.revision,
      },
    });
    await incrementManifestRevisions(
      tx,
      uniqueTargets(experiment.sites, experiment.environments)
    );
    return experiment;
  });
}

export async function updateExperiment(
  id: string,
  input: Partial<Omit<ExperimentInput, 'key'>>,
  actor: string,
  source: string
) {
  return db.$transaction(async (tx) => {
    const existing = await tx.experiment.findUniqueOrThrow({ where: { id } });
    if (existing.status === 'running' || existing.status === 'archived') {
      throw new Error('Running or archived experiments cannot be edited');
    }
    assertExperimentShape({
      startsAt:
        input.startsAt === undefined ? existing.startsAt : input.startsAt,
      stopsAt: input.stopsAt === undefined ? existing.stopsAt : input.stopsAt,
      variants: input.variants ?? existing.variants,
      patches: input.patches ?? existing.patches,
    });
    const { variants, targeting, patches, ...scalarInput } = input;
    const experiment = await tx.experiment.update({
      where: { id },
      data: {
        ...scalarInput,
        ...(variants ? { variants: variants as Prisma.InputJsonValue } : {}),
        ...(targeting ? { targeting: targeting as Prisma.InputJsonValue } : {}),
        ...(patches ? { patches: patches as Prisma.InputJsonValue } : {}),
        revision: { increment: 1 },
      },
    });
    await tx.experimentAudit.create({
      data: {
        experimentId: experiment.id,
        action: 'update',
        actor,
        source,
        revision: experiment.revision,
      },
    });
    const targets = [
      ...uniqueTargets(existing.sites, existing.environments),
      ...uniqueTargets(experiment.sites, experiment.environments),
    ];
    await incrementManifestRevisions(tx, [
      ...new Map(
        targets.map((target) => [
          `${target.site}:${target.environment}`,
          target,
        ])
      ).values(),
    ]);
    return experiment;
  });
}

async function assertLaunchable(tx: ExperimentTx, id: string) {
  const experiment = await tx.experiment.findUniqueOrThrow({ where: { id } });
  const variants = experiment.variants as Array<{ key?: string }>;
  const variantKeys = variants
    .map((variant) => variant.key)
    .filter(Boolean) as string[];
  const targets = uniqueTargets(experiment.sites, experiment.environments);

  for (const target of targets) {
    const placement = await tx.experimentPlacement.findUnique({
      where: { site_environment_slot: { ...target, slot: experiment.slot } },
    });
    if (
      !placement ||
      variantKeys.some((key) => !placement.variants.includes(key))
    ) {
      throw new Error(
        `Placement ${experiment.slot} and every variant must exist on ${target.site}/${target.environment}`
      );
    }
  }

  const conflicts = await tx.experiment.findMany({
    where: {
      id: { not: id },
      status: 'running',
      slot: experiment.slot,
      sites: { hasSome: experiment.sites },
      environments: { hasSome: experiment.environments },
    },
    select: { key: true },
  });
  if (conflicts.length) {
    throw new Error(
      `Slot is already controlled by: ${conflicts.map((item) => item.key).join(', ')}`
    );
  }
  return experiment;
}

const transitions: Record<
  string,
  { from: ExperimentStatus[]; to: ExperimentStatus }
> = {
  start: { from: ['draft', 'paused'], to: 'running' },
  pause: { from: ['running'], to: 'paused' },
  stop: { from: ['running', 'paused'], to: 'stopped' },
  archive: { from: ['draft', 'stopped'], to: 'archived' },
};

export async function transitionExperiment(
  id: string,
  action: string,
  actor: string,
  source: string,
  requestId: string
) {
  const transition = transitions[action];
  if (!transition) {
    throw new Error('Unsupported lifecycle action');
  }

  const experiment = await db.$transaction(async (tx) => {
    const replay = await tx.experimentLifecycleRequest.findUnique({
      where: { requestId },
    });
    if (replay) {
      throw new Error('Lifecycle request has already been processed');
    }
    const existing =
      action === 'start'
        ? await assertLaunchable(tx, id)
        : await tx.experiment.findUniqueOrThrow({ where: { id } });
    if (!transition.from.includes(existing.status)) {
      throw new Error(
        `Cannot ${action} an experiment in ${existing.status} state`
      );
    }
    await tx.experimentLifecycleRequest.create({
      data: { requestId, experimentId: id, action },
    });
    const experiment = await tx.experiment.update({
      where: { id },
      data: { status: transition.to, revision: { increment: 1 } },
    });
    await tx.experimentAudit.create({
      data: {
        experimentId: id,
        action,
        actor,
        source,
        revision: experiment.revision,
        details: { requestId },
      },
    });
    await incrementManifestRevisions(
      tx,
      uniqueTargets(experiment.sites, experiment.environments)
    );
    return experiment;
  });
  await notifyLifecycleWebhooks(experiment, action);
  return experiment;
}

async function notifyLifecycleWebhooks(
  experiment: {
    id: string;
    key: string;
    revision: number;
    sites: string[];
    environments: string[];
  },
  action: string
) {
  const signingKey = process.env.BCM_EXPERIMENTS_SIGNING_KEY;
  if (!(signingKey && process.env.BCM_EXPERIMENTS_WEBHOOK_URLS)) {
    return;
  }

  let configured: Record<string, string>;
  try {
    configured = JSON.parse(process.env.BCM_EXPERIMENTS_WEBHOOK_URLS);
  } catch {
    return;
  }
  const urls = [
    ...new Set(
      experiment.sites
        .map((site) => configured[site])
        .filter((url): url is string => /^https:\/\//.test(url || ''))
    ),
  ];
  if (!urls.length) {
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const eventId = randomUUID();
  const body = JSON.stringify({
    type: 'experiment.lifecycle',
    action,
    experiment_id: experiment.id,
    experiment_key: experiment.key,
    revision: experiment.revision,
    sites: experiment.sites,
    environments: experiment.environments,
    occurred_at: new Date().toISOString(),
  });
  const signature = createHmac('sha256', signingKey)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  await Promise.allSettled(
    urls.map((url) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BCM-Event-Id': eventId,
          'X-BCM-Timestamp': timestamp,
          'X-BCM-Signature': `sha256=${signature}`,
        },
        body,
        signal: AbortSignal.timeout(2000),
      })
    )
  );
}

export async function syncExperimentPlacements(
  placements: Array<{
    site: string;
    environment: string;
    slot: string;
    variants: string[];
    metadata: Record<string, unknown>;
  }>
) {
  return db.$transaction(async (tx) => {
    for (const placement of placements) {
      await tx.experimentPlacement.upsert({
        where: {
          site_environment_slot: {
            site: placement.site,
            environment: placement.environment,
            slot: placement.slot,
          },
        },
        create: {
          ...placement,
          metadata: placement.metadata as Prisma.InputJsonValue,
        },
        update: {
          variants: placement.variants,
          metadata: placement.metadata as Prisma.InputJsonValue,
          syncedAt: new Date(),
        },
      });
    }
    return { synchronized: placements.length };
  });
}

export async function getExperimentManifest(site: string, environment: string) {
  const now = new Date();
  const [revision, experiments] = await Promise.all([
    db.experimentManifestRevision.findUnique({
      where: { site_environment: { site, environment } },
    }),
    db.experiment.findMany({
      where: {
        status: 'running',
        sites: { has: site },
        environments: { has: environment },
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ stopsAt: null }, { stopsAt: { gt: now } }] }],
      },
      orderBy: { key: 'asc' },
    }),
  ]);
  const generatedAt = new Date();
  const manifest = {
    schema_version: 1,
    revision: revision?.revision ?? 1,
    generated_at: generatedAt.toISOString(),
    expires_at: new Date(generatedAt.getTime() + 5 * 60 * 1000).toISOString(),
    experiments: experiments.map((experiment) => ({
      id: experiment.id,
      key: experiment.key,
      revision: experiment.revision,
      slot: experiment.slot,
      status: experiment.status,
      salt: experiment.assignmentSalt,
      allocation: experiment.allocation,
      start_at: experiment.startsAt?.toISOString() ?? null,
      stop_at: experiment.stopsAt?.toISOString() ?? null,
      variants: experiment.variants,
      targeting: experiment.targeting,
      patches: experiment.patches,
      primary_event: experiment.primaryEvent,
      secondary_events: experiment.secondaryEvents,
      guardrail_events: experiment.guardrailEvents,
      exclusion_group: experiment.exclusionGroup,
    })),
  };
  const body = JSON.stringify(manifest);
  const etagSource = JSON.stringify({
    schema_version: manifest.schema_version,
    revision: manifest.revision,
    experiments: manifest.experiments,
  });
  const etag = `"${createHash('sha256').update(etagSource).digest('hex')}"`;
  return { manifest, body, etag };
}
