# BCM OpenPanel fork policy

This fork adds the BCM experiment control plane while retaining OpenPanel as
the analytics and results dashboard. It is deployed only from reviewed commits
and immutable container digests recorded in `sites/bcm-infra`.

The fork must retain upstream copyright and AGPL notices. Before making a
network-accessible production deployment, legal/engineering must confirm that
the corresponding source for the deployed revision is available as required by
the upstream license. Upstream sync pull requests must identify the old and new
fork points, run database migration compatibility checks, and publish new image
digests; production must never track an upstream branch or floating image tag.

Runtime configuration:

- `BCM_EXPERIMENTS_SIGNING_KEY`: HMAC key for signed manifests.
- `BCM_EXPERIMENTS_SERVICE_TOKENS_JSON`: property-to-token map loaded from SSM;
  requests are restricted to the sites owned by the supplied token.
- `BCM_EXPERIMENTS_SERVICE_TOKENS`: temporary comma-separated compatibility
  form for upgrades from the first fork release. It is ignored unless
  `BCM_EXPERIMENTS_ALLOW_GLOBAL_TOKEN=true`; production must leave that flag
  unset.
- `BCM_EXPERIMENTS_WEBHOOK_URLS`: property-to-HTTPS-endpoint map for signed
  lifecycle cache invalidation.
- `BCM_EXPERIMENTS_RATE_LIMIT_MAX`: management requests per minute.
- `API_CORS_ORIGINS`: explicit dashboard/site origins.

Service tokens and the signing key are server-only. The browser receives only
the existing OpenPanel public client ID for its property.
