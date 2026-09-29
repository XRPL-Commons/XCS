-- Local development only. The PostgreSQL image runs this once for a fresh data
-- directory. Production users and passwords are created by DigitalOcean; the
-- XCS bootstrap only applies migrations and least-privilege grants.
--
-- These fixed published literals are not secrets and must never be reused
-- outside this local Compose stack.

CREATE ROLE xcs_indexer LOGIN PASSWORD 'local-development-only-not-a-secret-indexer';
CREATE ROLE xcs_api LOGIN PASSWORD 'local-development-only-not-a-secret-api';
CREATE ROLE xcs_payload_writer LOGIN PASSWORD 'local-development-only-not-a-secret-payload';
CREATE ROLE xcs_monitor LOGIN PASSWORD 'local-development-only-not-a-secret-monitor';
CREATE ROLE xcs_app LOGIN PASSWORD 'local-development-only-not-a-secret-app';
CREATE ROLE xcs_admin_app LOGIN PASSWORD 'local-development-only-not-a-secret-admin-app';
CREATE ROLE xcs_notifier LOGIN PASSWORD 'local-development-only-not-a-secret-notifier';
CREATE ROLE xcs_issuer LOGIN PASSWORD 'local-development-only-not-a-secret-issuer';
