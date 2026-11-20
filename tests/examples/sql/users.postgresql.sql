-- Schema for tests/examples/database.spec.ts (PostgreSQL), used as a container init script:
--   PW_DB_CONTAINER=true PW_DB_CONTAINER_INIT=tests/examples/sql/users.postgresql.sql
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name TEXT,
    email TEXT,
    active BOOLEAN
);
