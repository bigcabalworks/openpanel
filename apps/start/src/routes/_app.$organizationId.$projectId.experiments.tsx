import { useMutation, useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { FlaskConicalIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageContainer } from '@/components/page-container';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { handleError, useTRPC } from '@/integrations/trpc/react';
import { createProjectTitle } from '@/utils/title';

export const Route = createFileRoute(
  '/_app/$organizationId/$projectId/experiments'
)({
  component: Component,
  head: () => ({ meta: [{ title: createProjectTitle('Experiments') }] }),
});

const inputClass =
  'h-9 rounded-md border border-input bg-background px-3 text-sm';

type ExperimentEnvironment =
  | 'local'
  | 'development'
  | 'dev'
  | 'uat'
  | 'staging'
  | 'production'
  | 'prod';

function Component() {
  const { projectId } = Route.useParams();
  const trpc = useTRPC();
  const query = useQuery(trpc.experiment.list.queryOptions({ projectId }));
  const [form, setForm] = useState({
    key: '',
    name: '',
    slot: '',
    sites: '',
    environments: 'uat',
    primaryEvent: '',
    variants: 'control:50\nvariant:50',
  });
  const [allocations, setAllocations] = useState<Record<string, string>>({});

  const transition = useMutation(
    trpc.experiment.transition.mutationOptions({
      onError: handleError,
      onSuccess() {
        query.refetch();
        toast.success('Experiment lifecycle updated');
      },
    })
  );
  const create = useMutation(
    trpc.experiment.create.mutationOptions({
      onError: handleError,
      onSuccess() {
        query.refetch();
        setForm((value) => ({
          ...value,
          key: '',
          name: '',
          slot: '',
          primaryEvent: '',
        }));
        toast.success('Experiment draft created');
      },
    })
  );
  const update = useMutation(
    trpc.experiment.update.mutationOptions({
      onError: handleError,
      onSuccess() {
        query.refetch();
        toast.success('Experiment draft updated');
      },
    })
  );

  function createDraft(event: React.FormEvent) {
    event.preventDefault();
    const variants = form.variants
      .split('\n')
      .map((line) => line.trim().split(':'))
      .filter(([key, weight]) => key && weight)
      .map(([key, weight]) => ({ key: key!, weight: Number(weight) }));
    create.mutate({
      projectId,
      experiment: {
        key: form.key,
        name: form.name,
        slot: form.slot,
        sites: form.sites
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
        environments: form.environments
          .split(',')
          .map((value) => value.trim()) as ExperimentEnvironment[],
        primaryEvent: form.primaryEvent,
        variants,
        allocation: 1,
        targeting: [],
        patches: [],
        secondaryEvents: [],
        guardrailEvents: [],
      },
    });
  }

  return (
    <PageContainer>
      <PageHeader
        className="mb-8"
        description="Manage BCM experiment drafts, launches, kill switches, and audit history. Results remain in OpenPanel reports."
        title="Experiments"
      />

      <form
        className="mb-8 rounded-lg border bg-card p-5"
        onSubmit={createDraft}
      >
        <div className="mb-4 flex items-center gap-2 font-medium">
          <FlaskConicalIcon size={18} />
          Create draft
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {(
            [
              'key',
              'name',
              'slot',
              'sites',
              'environments',
              'primaryEvent',
            ] as const
          ).map((field) => (
            <label className="flex flex-col gap-1 text-sm" key={field}>
              <span className="text-muted-foreground">{field}</span>
              <input
                className={inputClass}
                onChange={(event) =>
                  setForm({ ...form, [field]: event.target.value })
                }
                required
                value={form[field]}
              />
            </label>
          ))}
          <label className="flex flex-col gap-1 text-sm md:col-span-3">
            <span className="text-muted-foreground">
              Variants, one key:weight per line
            </span>
            <textarea
              className="min-h-20 rounded-md border border-input bg-background p-3 font-mono text-sm"
              onChange={(event) =>
                setForm({ ...form, variants: event.target.value })
              }
              value={form.variants}
            />
          </label>
        </div>
        <Button className="mt-4" loading={create.isPending} type="submit">
          Create draft
        </Button>
      </form>

      <div className="space-y-3">
        {(query.data ?? []).map((experiment) => (
          <div className="rounded-lg border bg-card p-5" key={experiment.id}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="font-medium">{experiment.name}</div>
                <div className="text-muted-foreground text-sm">
                  {experiment.key} · {experiment.slot} · revision{' '}
                  {experiment.revision}
                </div>
              </div>
              <span className="rounded bg-muted px-2 py-1 text-xs uppercase">
                {experiment.status}
              </span>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {experiment.status !== 'running' &&
                experiment.status !== 'archived' && (
                  <div className="flex items-center gap-2">
                    <label className="text-muted-foreground text-sm">
                      Allocation
                    </label>
                    <input
                      aria-label={`Allocation for ${experiment.name}`}
                      className={`${inputClass} w-24`}
                      max="1"
                      min="0"
                      onChange={(event) =>
                        setAllocations((values) => ({
                          ...values,
                          [experiment.id]: event.target.value,
                        }))
                      }
                      step="0.01"
                      type="number"
                      value={
                        allocations[experiment.id] ??
                        String(experiment.allocation)
                      }
                    />
                    <Button
                      loading={update.isPending}
                      onClick={() =>
                        update.mutate({
                          projectId,
                          id: experiment.id,
                          experiment: {
                            allocation: Number(
                              allocations[experiment.id] ??
                                experiment.allocation
                            ),
                          },
                        })
                      }
                      variant="outline"
                    >
                      Update
                    </Button>
                  </div>
                )}
              {experiment.status !== 'running' &&
                experiment.status !== 'archived' &&
                experiment.status !== 'stopped' && (
                  <Button
                    onClick={() =>
                      transition.mutate({
                        projectId,
                        id: experiment.id,
                        action: 'start',
                      })
                    }
                  >
                    Start
                  </Button>
                )}
              {experiment.status === 'running' && (
                <Button
                  onClick={() =>
                    transition.mutate({
                      projectId,
                      id: experiment.id,
                      action: 'pause',
                    })
                  }
                  variant="secondary"
                >
                  Pause
                </Button>
              )}
              {(experiment.status === 'running' ||
                experiment.status === 'paused') && (
                <Button
                  onClick={() =>
                    transition.mutate({
                      projectId,
                      id: experiment.id,
                      action: 'stop',
                    })
                  }
                  variant="destructive"
                >
                  Stop
                </Button>
              )}
              {(experiment.status === 'draft' ||
                experiment.status === 'stopped') && (
                <Button
                  onClick={() =>
                    transition.mutate({
                      projectId,
                      id: experiment.id,
                      action: 'archive',
                    })
                  }
                  variant="outline"
                >
                  Archive
                </Button>
              )}
            </div>
            {experiment.audit[0] && (
              <div className="mt-4 text-muted-foreground text-xs">
                Last action: {experiment.audit[0].action} by{' '}
                {experiment.audit[0].actor}
              </div>
            )}
          </div>
        ))}
        {!(query.isLoading || query.data?.length) && (
          <div className="rounded-lg border border-dashed p-10 text-center text-muted-foreground">
            No experiment drafts yet.
          </div>
        )}
      </div>
    </PageContainer>
  );
}
