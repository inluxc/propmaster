---
title: Coverage
description: What the tests cover per layer (unit, integration, e2e), for people and for AI agents.
---

# Coverage

A line-coverage percentage says how much of the code ran. It doesn't say which API operations have no test, which error codes nobody asserts, which tables no test reads, or that half the e2e suite hasn't run in a month. `propmaster coverage` (and the `coverage_report` MCP tool) collects those facts per layer of the test pyramid, so you, or an agent, can judge what is covered and what to test next.

It reads files only: the test sources, the [test history](./flaky-tests), the OpenAPI spec and any code-coverage reports already in the project. It runs no tests and touches no backend. The application can be written in any language: its own tests and coverage reports count too.

```bash
npx propmaster coverage
```

```
Coverage: 9 tests in 5 files

  unit            4 tests (unit 4), 1 skipped/fixme · last run 1✓ 0~ 0✗ 3 not run · pass rate 100%
  integration     4 tests (api 3, integration 1), 1 skipped/fixme · last run 0✓ 1~ 1✗ 2 not run · pass rate 50%
                    touches 3 operations, 2 tables, 1 topic
  e2e             1 tests (e2e 1)
                    touches 2 routes

API (./specs/shop.json): 3/4 operations tested (75%), 57.1% of documented status codes asserted

Code coverage:
  e2e             75% lines, 50% branches  app/coverage/e2e/coverage-summary.json (istanbul-summary, 1 files)
  unit          27.5% lines, 50% branches  coverage/lcov.info (lcov, 2 files)

Gaps:
  • 1 of 4 API operations have no test.
      deleteOrder DELETE /orders/{id}
  • 2 tested operation(s) assert no error status (4xx/5xx), though the spec documents some.
      listOrders — documented 401
      getOrder — documented 404
  • Configured for this environment, but no test uses it: redis.
      redis (redisClient)
  • 1 test(s) failed in their latest run: what they cover isn't verified.
      TC-API-002 creates an order
  • coverage/lcov.info: 27.5% of lines covered (unit).
      src/b.ts 10% (27 lines uncovered)
      src/a.ts 80% (2 lines uncovered)
```

## Layers

Each test gets a layer from the fixtures it requests, the same way [`propmaster organize`](./guide/cli) sorts tests into folders:

| Layer | Kind | How it's recognised |
|---|---|---|
| **unit** | `unit` | No service, browser or device fixture; also Vitest, Jest, Mocha and `node:test` files (`it()` / `test()` calls) |
| | `property` | `*.prop.ts`, or a `properties/` folder |
| **integration** | `api` | `openApiClient`, `graphqlClient`, `grpcClient`, `realtimeClient`, `request` |
| | `integration` | A database, broker, cache or storage client; `inboxClient`, `mockServer` |
| **e2e** | `e2e` | `page`, `context`, `browser` |
| | `mobile` | `appiumDriver`, `gadsHub` |

`testData` and the auth fixtures say nothing about the layer. A test with custom fixtures gets its layer from its folder (`tests/e2e/`, `tests/integration/`, `*.e2e.ts`, ...); one whose folder doesn't tell either is listed as unclassified.

### Tests in other languages

The application's own tests are found and counted wherever they are in the project:

| Language | Test files | Tests |
|---|---|---|
| Python | `test_*.py`, `*_test.py` | `def test_...` (pytest, unittest) |
| Go | `*_test.go` | `func TestX(t *testing.T)` |
| Java, Kotlin, Scala, Groovy | `*Test`, `*Tests`, `*IT`, `*Spec`, or under `src/test/` | `@Test`, `@ParameterizedTest`, ...; Spock, Kotest and ScalaTest string tests |
| C# | `*Test.cs`, `*Tests.cs` | `[Fact]`, `[Theory]`, `[Test]`, `[TestMethod]`, `[TestCase]` |
| Ruby | `*_spec.rb`, `*_test.rb` | `it "..."`, `test "..."`, `def test_...` |
| PHP | `*Test.php` | `function test...`, `#[Test]`, Pest `it()` / `test()` |
| Rust | `*.rs` | `#[test]`, `#[tokio::test]`, ... |
| Swift | `*Test.swift`, `*Tests.swift` | `func test...`, `@Test` |
| Elixir | `*_test.exs` | `test "..."` |

They're unit tests unless something says otherwise:

- **A folder:** `integration/`, `it/`, `functional/`, `e2e/`, `acceptance/`.
- **The language's convention:** Maven and Gradle `*IT`, Rust's `tests/` folder, a Go `//go:build integration` tag.
- **A harness the file uses:** Testcontainers, `WebApplicationFactory`, `@SpringBootTest`, `@DataJpaTest`, `@QuarkusTest`, Rails request specs or `ActionDispatch::IntegrationTest` and Django's `LiveServerTestCase` make it integration. Playwright, Selenium, Capybara, XCUITest, Espresso and chromedp make it e2e.
- **A real backend in its folder or name:** `Postgres/`, `OrderRepositoryPostgresTests`, `redis_cache_test.go`. The same goes for MySQL, SQL Server, Redis, Kafka, RabbitMQ, MongoDB, DynamoDB, LocalStack, Elasticsearch, OpenSearch, Cassandra, ClickHouse and Neo4j.
- **A marker on the test:** `@pytest.mark.integration`, `@Tag("integration")`, `[Trait("Category", "Integration")]`. Skip markers (`@pytest.mark.skip`, `@Disabled`, `[Fact(Skip = ...)]`, `#[ignore]`, `xit`, `@tag :skip`) mark the test as not active. Each layer lists its tests per language.

## What a test touches

Read from each test's body:

| Kind | From |
|---|---|
| `operation` | Calls to an `operationId` (any `.listOrders(` when there's a spec, else calls on `client`), `checkResponse(res, 'id')` |
| `http` | `request.get('/path')`, `authRequest.post(...)`; in any language: `client.get("/orders")` (pytest, supertest, Laravel), `get("/orders")` (MockMvc, Rails), `GetAsync("/orders")`, `PostAsJsonAsync($"/orders/{id}", ...)`, `GetFromJsonAsync<T>(...)` and `new HttpRequestMessage(HttpMethod.Post, "/orders")` (.NET), `http.NewRequest("GET", "/orders", ...)` (Go). URLs kept in a variable (`client.GetAsync(ordersUrl)`) aren't followed |
| `graphql`, `grpc` | `query GetUser {`, `'orders.v1.Orders/Get'` |
| `table` | Table names in SQL statements sent through `databaseClient` / `cassandraClient` / `clickHouseClient` (in any string literal, for other languages), and `insert('table', ...)`; DynamoDB tables |
| `collection`, `label` | MongoDB collections, Neo4j labels in Cypher |
| `topic`, `queue`, `exchange`, `channel`, `index`, `bucket`, `stream` | The first argument of the Kafka, RabbitMQ, SQS/SNS, Redis pub/sub, search, S3 and realtime client calls |
| `route`, `deeplink` | `page.goto('/cart')`, `appiumDriver.url('myapp://...')` |

A name can be a literal or a constant in the file: `const topic = 'orders'` and `const topic = testData.unique('orders')` both count as `orders`. Names built at run time (`` `${prefix}-orders` ``) can't be read and are left out, so treat the lists as a floor, not the whole picture.

## API operations and status codes

With an OpenAPI spec (`openapi.specPath`, `--spec`), every operation is listed with its documented status codes and the ones a test asserts: `expect(res.status).toBe(404)`, `toHaveStatus(404)`, or an `annotation: { type: 'openapi', description: 'getOrder 404' }`. A status asserted in a test that calls several operations counts for each of them.

A test reaches an operation by calling its `operationId` on `openApiClient`, or, in any language, by an HTTP call whose method and path match the operation's: `GET /v1/orders/42`, `f"/orders/{id}"`, `"/orders/" + id` and `` `/orders/${id}` `` all match `GET /orders/{id}` (any base path in front is allowed). Statuses in other languages are read from lines about a status, as numbers or names: `assert res.status_code == 404`, `status().isNotFound()`, `HttpStatusCode.NotFound`, `have_http_status(:not_found)`, `http.StatusNotFound`.

The gaps list operations with no test, tested operations that never assert an error status the spec documents, and other documented codes nobody asserts. [`propmaster generate openapi`](./guide/cli) writes the missing ones.

## Code coverage

Reports the project's own tools already write are read as they are, whatever the language:

| Format | Files | Written by |
|---|---|---|
| LCOV | `lcov.info` | Istanbul/nyc, c8, Jest, Vitest, coverage.py, gcov/lcov, grcov, cargo-llvm-cov, tarpaulin, Dart, excoveralls |
| Istanbul summary | `coverage-summary.json` | the `json-summary` reporter |
| Cobertura | `*cobertura*.xml`, `coverage.xml` | coverage.py, coverlet (.NET), gcovr, tarpaulin, gocover-cobertura, Kover, PHPUnit |
| JaCoCo | `jacoco*.xml` | Java, Kotlin, Scala, Groovy builds (also Kover) |
| Clover | `clover.xml` | PHPUnit, OpenClover, Istanbul |
| OpenCover | `*opencover*.xml` | coverlet, OpenCover (.NET) |
| Go cover profile | `coverage.out`, `cover.out`, `*.coverprofile` | `go test -coverprofile` |
| coverage.py JSON | `coverage.json` | `coverage json` |
| SimpleCov | `.resultset.json` | SimpleCov (Ruby) |

Go, coverage.py, Clover and OpenCover count statements rather than lines; the report says which (`measure`). Istanbul's `clover.xml` fills its "statements" field with its line counts, so it matches the LCOV next to it. The least-covered list leaves out generated and vendored code (`*.pb.go`, `*_pb2.py`, `*.g.cs`, `Migrations/`, `node_modules/`, `vendor/`, ...), which still counts in the totals. When one run writes several formats into one folder (Jest's `lcov.info`, `clover.xml` and `coverage-summary.json`), only one is read. A file with a generic name (`coverage.out`, `coverage.json`) that isn't a coverage report is left out.

They're found anywhere in the project, six folders down at most, or named with `--report` (repeatable). The layer comes from the path: `coverage/e2e/lcov.info` is e2e, `build/integration/...` integration, anything else unit. Reports under 60% get a gap with their least-covered files; reports older than 30 days are flagged as stale.

Propmaster doesn't instrument the application: to see the lines your integration or e2e tests reach, run the application under its own coverage tool while the tests run (c8 or nyc for Node.js, the JaCoCo agent for the JVM, `coverage run` for Python, a binary built with `go build -cover` and `GOCOVERDIR`, coverlet for .NET, SimpleCov for Ruby), and write the report under a folder named for the layer.

## History

With the [Propmaster reporter](./flaky-tests) in `playwright.config.ts`, each layer gets its last run (passed, flaky, failed, not run) and its pass rate over the last 30 runs (`--runs`). Tests that are in the code but in none of those runs (Playwright tests only: other runners don't write to the history), tests whose latest run failed, quarantined tests and tests marked `skip`, `fixme` or `fail` are gaps: what they cover isn't verified.

## Options

```bash
npx propmaster coverage --layer e2e                        # one layer
npx propmaster coverage --spec https://api.example.test/openapi.json
npx propmaster coverage --no-spec                          # leave the API part out
npx propmaster coverage --report ../app/coverage/lcov.info # a report outside the defaults
npx propmaster coverage --json --tests                     # everything, with each test and what it touches
```

`-e <env>` picks the environment whose spec and backends are used (default `PW_ENVIRONMENT`, else `local`).

## With an AI agent

The [MCP server](./mcp-server) has the same report as the `coverage_report` tool, so an agent can build a sense of the project's coverage before it writes tests:

1. `coverage_report` for the layers, the gaps and the code-coverage reports; `tests: true` adds every test with what it touches.
2. The real backends to compare against: `openapi_operations` for the spec, `db_query` on `information_schema.tables` (or `sqlite_master`) for tables no test reads or writes, `kafka_topics` for topics no test uses.
3. The application code behind the untested operations and the least-covered files, to judge which gaps matter: money, auth and data loss before cosmetic pages.
4. `next_test_id`, the tests, then `check_tests` and `run_tests`.

Ask it, for example: *"Use coverage_report and the backends to tell me where our tests are thin, and write the three tests that would catch the most."*

The report's `nextSteps` lists what would sharpen it (a spec, a test history, a coverage report) and which comparisons to make.
