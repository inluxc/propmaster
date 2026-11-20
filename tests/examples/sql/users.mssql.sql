-- Schema for tests/examples/database.spec.ts (MSSQL), used as a container init script.
IF OBJECT_ID(N'dbo.users', N'U') IS NULL
CREATE TABLE users (
    id INT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(255),
    email NVARCHAR(255),
    active BIT
);
