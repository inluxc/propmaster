-- Schema for tests/examples/database.spec.ts (MySQL), used as a container init script.
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255),
    email VARCHAR(255),
    active BOOLEAN
);
