-- Apply after 1293-fork.2.sql to represent the pre-migration-5 release.
ALTER TABLE projection_threads ADD COLUMN branch_pull_request_json TEXT;
ALTER TABLE projection_threads ADD COLUMN active_order_key TEXT;
INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES
  (53, 'ProjectionThreadBranchPullRequest', '2026-09-01 00:00:00'),
  (54, 'ProjectionThreadsActiveOrderKey', '2026-09-01 00:00:00');
