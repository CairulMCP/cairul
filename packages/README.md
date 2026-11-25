# Cairul integration packages

Each integration is a standalone `@cairul/<name>-plugin` package with its own repository and release pipeline. This checkout pins those repositories as Git submodules for integration testing. Install or link the packages you need into the project from which Cairul resolves dependencies. When working from a checkout, run `pnpm install` here first, then run `pnpm link /path/to/cairul/packages/vitest-plugin` in your project. `shell.command` comes with the MCP and accepts the `command:` shorthand.

Declare installed packages in `.cairul/plugins.yaml`. Restart the MCP after changing the list.

```yaml
plugins:
  - package: '@cairul/vitest-plugin'
  - package: '@cairul/playwright-plugin'
  - package: '@cairul/github-plugin'
    options:
      tokenEnv: GITHUB_TOKEN
```

Add reusable definitions in `.cairul/checks.yaml` and reference them by name in a plan phase. The same definitions also work inline.

```yaml
checks:
  - name: Unit tests
    kind: vitest.passed
    options:
      reports: reports/vitest.xml
      minTests: 20
  - name: Browser tests
    kind: playwright.passed
    options:
      reports: reports/playwright.json
      maxSkipped: 0
  - name: Merge
    kind: github.pr-merged
    options:
      repository: acme/service
      number: 42
```

## Work trackers and source control

Service plugins use read operations. Most checks infer IDs from a matching work-item URL. Set IDs explicitly when a journey needs to check another service. The [credential reference](#work-item-credentials) lists the environment and YAML options.

| Package               | Check kinds                                                                                                                                                                    | Connection and inputs                                                                                                                                                                                                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `github-plugin`       | `github.issue-state`, `github.issue-labels`, `github.issue-linked-prs-merged`, `github.pr-merged`, `github.pr-approvals`, `github.check-passed`, `github.deployment-succeeded` | `GITHUB_TOKEN`. Use `repository` and `number` to override URL routing. Named checks take `name`, optional `app`, and a full `sha` when targeting a specific revision. Deployment checks take `repository`, `sha`, and `environment`. For GitHub Enterprise, `baseUrl` can point to `/api/v3` and `graphqlUrl` can point to the GraphQL API root before `/graphql`. |
| `gitlab-plugin`       | `gitlab.issue-state`, `gitlab.mr-merged`, `gitlab.mr-approved`, `gitlab.pipeline-passed`, `gitlab.pipeline-job-passed`, `gitlab.job-artifact-present`                          | `GITLAB_TOKEN`. Use `project` and `iid` to override the URL. Pipeline checks accept `pipelineId`. Job checks take `name`. Artifact presence checks take `project`, `job`, and optional `filename`. For a self-managed instance, set `baseUrl` to the API root ending in `/api/v4`.                                                                                 |
| `perforce-plugin`     | `perforce.changelist-shelved`, `perforce.changelist-submitted`, `perforce.job-linked`, `perforce.review-state`                                                                 | Configure the local `p4` CLI and use `change` and, for linked jobs, `job`. Reviews take `review` and optional `state` (defaults to `approved`). They use the P4 Code Review API root and `P4_REVIEW_TOKEN`. For Basic auth, set `email` to the P4 username and provide its ticket in the token variable.                                                           |
| `linear-plugin`       | `linear.issue-state`, `linear.issue-labels`, `linear.no-blockers`, `linear.sub-issues-complete`                                                                                | `LINEAR_API_KEY`. Check options include `issue`, `state`, and `labels`.                                                                                                                                                                                                                                                                                            |
| `jira-plugin`         | `jira.issue-status`, `jira.issue-resolution`, `jira.issue-field-present`, `jira.no-blockers`, `jira.jql-matches`                                                               | Set the Jira Cloud site `baseUrl`; supply `JIRA_API_TOKEN` and set `email` for Basic auth. Use `issue` to override URL routing, and `state`, `field`, `relationship`, or `jql` as appropriate. JQL accepts `expected: some` or `expected: none`.                                                                                                                   |
| `trello-plugin`       | `trello.card-list`, `trello.card-labels`, `trello.checklist-complete`, `trello.card-attachments`                                                                               | `TRELLO_TOKEN`. Use the API key options below for key-and-token authentication. Use `card` to override routing, and `listId`, `labels`, checklist `name`, or attachment `names` as appropriate.                                                                                                                                                                    |
| `asana-plugin`        | `asana.task-complete`, `asana.task-tags`, `asana.approval-accepted`                                                                                                            | `ASANA_TOKEN`. Override routing with `task`; tag checks take `tags`.                                                                                                                                                                                                                                                                                               |
| `clickup-plugin`      | `clickup.task-status`, `clickup.task-tags`, `clickup.task-field-present`                                                                                                       | `CLICKUP_TOKEN` for a personal API token. Use `task`, `state`, `tags`, or `fieldId` as appropriate.                                                                                                                                                                                                                                                                |
| `monday-plugin`       | `monday.item-status`, `monday.column-present`                                                                                                                                  | `MONDAY_TOKEN`. Supply `item`, `column`, and `state` for the status check.                                                                                                                                                                                                                                                                                         |
| `notion-plugin`       | `notion.page-status`, `notion.property-present`                                                                                                                                | `NOTION_TOKEN`. Supply `property`, `state` for the status check, and an explicit `page` if the URL does not contain its ID.                                                                                                                                                                                                                                        |
| `azure-devops-plugin` | `azure-devops.work-item-state`, `azure-devops.work-item-field-present`                                                                                                         | `AZURE_DEVOPS_PAT`; set the organization as plugin-level `workspace`. Use `workItem` to override routing, and supply `state` or `field`.                                                                                                                                                                                                                           |
| `bitbucket-plugin`    | `bitbucket.pr-merged`, `bitbucket.pr-approvals`                                                                                                                                | `BITBUCKET_TOKEN`. Supply `email` for Basic auth. Use `repository`, `number`, or a Bitbucket Cloud PR URL. Approval checks accept `minimum` (defaults to 1).                                                                                                                                                                                                       |
| `youtrack-plugin`     | `youtrack.issue-state`, `youtrack.issue-resolved`                                                                                                                              | Set a site `baseUrl` and provide `YOUTRACK_TOKEN`. Set `issue` to override URL routing. The state check accepts `state` and a custom `field` (defaults to `State`).                                                                                                                                                                                                |
| `workspace-plugin`    | `file.exists`, `json.matches`, `yaml.matches`, `http.status`                                                                                                                   | File checks take a workspace-relative `path`. Document checks take a `fields` array of keys or numeric indexes and an `equals` value. HTTP checks take `url` and optional `status` (defaults to 200).                                                                                                                                                              |

## Work-item credentials

Use `plugins.yaml` for connection settings, public IDs, credential file paths, and environment variable names. Put raw tokens, passwords, and PEM contents in the MCP's environment or in private files outside the repository. Cairul requires absolute credential file paths and owner-only permissions on Unix (for example, `chmod 600`). Authenticated HTTP requests use HTTPS, with loopback allowed for local integrations and tests.

For each provider, `CAIRUL_<PROVIDER>_BASE_URL` overrides YAML `baseUrl`. Where the provider uses an email or organization, `CAIRUL_<PROVIDER>_EMAIL` and `CAIRUL_<PROVIDER>_WORKSPACE` override email and `workspace` in YAML. Credentials are resolved in this order:

1. `CAIRUL_<PROVIDER>_TOKEN` contains the raw token.
2. `CAIRUL_<PROVIDER>_TOKEN_FILE` points to a private token file.
3. `CAIRUL_<PROVIDER>_TOKEN_ENV` names another environment variable. YAML `tokenEnv` can also name a variable.
4. An existing provider variable, such as `GITHUB_TOKEN` or `LINEAR_API_KEY`.
5. The YAML `tokenFile`.

The bundled Codex plugin forwards the documented variables. To use a custom variable name through `tokenEnv`, make that variable available to the MCP process as well. Restart the MCP after changing its launch environment.

| Provider                    | Environment prefix     |
| --------------------------- | ---------------------- |
| GitHub                      | `CAIRUL_GITHUB_`       |
| GitLab                      | `CAIRUL_GITLAB_`       |
| Perforce and P4 Code Review | `CAIRUL_PERFORCE_`     |
| Linear                      | `CAIRUL_LINEAR_`       |
| Jira                        | `CAIRUL_JIRA_`         |
| Trello                      | `CAIRUL_TRELLO_`       |
| Asana                       | `CAIRUL_ASANA_`        |
| ClickUp                     | `CAIRUL_CLICKUP_`      |
| monday.com                  | `CAIRUL_MONDAY_`       |
| Notion                      | `CAIRUL_NOTION_`       |
| Azure DevOps                | `CAIRUL_AZURE_DEVOPS_` |
| Bitbucket                   | `CAIRUL_BITBUCKET_`    |
| YouTrack                    | `CAIRUL_YOUTRACK_`     |

### GitHub App

Set `appId`, `installationId`, and `privateKeyFile` in .cairul/plugins.yaml. Cairul uses the key to sign a short-lived JWT and caches GitHub's installation access token until it is near expiration. GitHub REST and GraphQL share the same configured origin.

```yaml
plugins:
  - package: '@cairul/github-plugin'
    options:
      authMode: app
      appId: 12345
      installationId: 67890
      privateKeyFile: /Users/you/.config/cairul/github-app.pem
```

`CAIRUL_GITHUB_APP_ID`, `CAIRUL_GITHUB_INSTALLATION_ID`, and `CAIRUL_GITHUB_GRAPHQL_URL` override YAML. For the PEM, use `CAIRUL_GITHUB_APP_PRIVATE_KEY` for the raw multiline value or `CAIRUL_GITHUB_APP_PRIVATE_KEY_FILE` for its path. `CAIRUL_GITHUB_APP_PRIVATE_KEY_ENV` can point at a different environment variable. `CAIRUL_GITHUB_AUTH_MODE` selects app or token explicitly. Otherwise explicit app settings in the environment select App mode, or explicit token settings in the environment select token mode. YAML controls the mode when neither is configured.

### Provider authentication modes

Set `authMode` in YAML or `CAIRUL_<PROVIDER>_AUTH_MODE` in the environment. Choose the mode that matches the credential you've provisioned. OAuth modes consume access tokens issued through the provider's authorization flow. Update the token or its file when the provider rotates it.

| Provider     | `authMode` and credential                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub       | `app` exchanges a GitHub App key for an installation token. `token` accepts classic and fine-grained PATs, OAuth user tokens, GitHub App user tokens, and pre-issued installation tokens.                                                                                                                                                                                                                                               |
| GitLab       | `private-token` (default) accepts personal, project, group, and impersonation tokens. `bearer` accepts OAuth access tokens. `job-token` accepts a CI job token from `CI_JOB_TOKEN` or the standard token settings and is limited to GitLab's supported endpoints. `session` expects only the `_gitlab_session` cookie value. `sudoUser` or `CAIRUL_GITLAB_SUDO_USER` can select an identity when using a permitted administrator token. |
| Perforce     | `basic` uses a P4 username in email and a login ticket for P4 Code Review. `bearer` is available for gateways that accept `bearer` tokens. Native p4 uses its configured password, tickets, or SSO helper, including `P4LOGINSSO` and `P4TRUST`.                                                                                                                                                                                        |
| Linear       | `api-key` (default) sends a personal API key. `bearer` sends a Linear OAuth access token.                                                                                                                                                                                                                                                                                                                                               |
| Jira         | `basic` accepts user and API token or Data Center password where enabled. `bearer` accepts an OAuth access token or a Data Center PAT. `connect` signs requests for an installed Connect app. `connect-jwt` accepts a pre-issued request JWT. `oauth1` signs Jira Data Center requests using the application's RSA private key.                                                                                                         |
| Trello       | `auto` (default) uses the key-and-token header when an API key is available, or an OAuth 2.0 Bearer token otherwise. Choose `bearer`, `key-token`, or `oauth1` explicitly to match your credential. `oauth1` signs requests with the consumer and token secrets.                                                                                                                                                                        |
| Asana        | `bearer` accepts personal, OAuth, and service-account access tokens.                                                                                                                                                                                                                                                                                                                                                                    |
| ClickUp      | `api-token` accepts a personal token. Use `bearer` for a ClickUp OAuth access token.                                                                                                                                                                                                                                                                                                                                                    |
| monday.com   | `api-token` accepts a personal V2 API token or a legacy app token. Use `bearer` for an OAuth 2.1 access token.                                                                                                                                                                                                                                                                                                                          |
| Notion       | `bearer` accepts internal integration secrets and OAuth access tokens.                                                                                                                                                                                                                                                                                                                                                                  |
| Azure DevOps | `pat` (default) uses a personal access token. `bearer` uses a Microsoft Entra access token, including service principal and managed identity tokens.                                                                                                                                                                                                                                                                                    |
| Bitbucket    | `basic` uses an Atlassian account email and API token. `bearer` accepts OAuth and workspace, project, or repository tokens.                                                                                                                                                                                                                                                                                                             |
| YouTrack     | `bearer` accepts permanent and OAuth access tokens.                                                                                                                                                                                                                                                                                                                                                                                     |

For Jira Cloud OAuth or scoped API tokens, use `baseUrl` under `https://api.atlassian.com/ex/jira/<cloudId>`, and set `siteUrl` to the Jira site to resolve issue URLs. The Jira Data Center v2 API uses `apiVersion`: '2'. Each of these also accepts an environment override with the `CAIRUL_JIRA_` prefix.

For Jira Connect, set `connectAppKey` or `CAIRUL_JIRA_CONNECT_APP_KEY` and supply the shared secret through the standard token settings. For Jira Data Center OAuth 1.0, set `consumerKey` or `CAIRUL_JIRA_CONSUMER_KEY`, pass the OAuth access token through the standard token settings, and set `privateKeyFile` or `CAIRUL_JIRA_OAUTH_PRIVATE_KEY_FILE`. `CAIRUL_JIRA_OAUTH_PRIVATE_KEY` accepts the raw PEM in the environment.

For Trello key-based auth, `keyFile` or `keyEnv` in YAML can supply the API key. The environment also supports `CAIRUL_TRELLO_KEY`, its _FILE and _ENV variants, and `TRELLO_API_KEY`. OAuth 1.0 additionally uses `keySecretFile` and `tokenSecretFile` or `CAIRUL_TRELLO_KEY_SECRET` and `CAIRUL_TRELLO_TOKEN_SECRET`, including their _FILE and _ENV variants.

For Perforce CLI checks, executable, port, user, client, `ticketsFile`, and config in YAML map to `CAIRUL_PERFORCE_EXECUTABLE`, `CAIRUL_PERFORCE_PORT`, `CAIRUL_PERFORCE_USER`, `CAIRUL_PERFORCE_CLIENT`, `CAIRUL_PERFORCE_TICKETS_FILE`, and `CAIRUL_PERFORCE_CONFIG`. Standard P4 environment values also take precedence over YAML defaults. Use `CAIRUL_PERFORCE_PASSWORD` or `P4PASSWD` for a raw password or ticket.

## Run tests locally

Each framework runner exposes a `<framework>.run` check. Install the test runner on PATH or in your project's `node_modules/.bin`. Override the executable and fixed arguments with plugin-level `options.command`, such as a Gradle wrapper or a Java command with the project classpath.

```yaml
- name: Checkout rejects expired cards
  kind: playwright.run
  options:
    select:
      files: [tests/checkout.spec.ts]
      titlePattern: rejects an expired card
      projects: [chromium]
    timeoutSeconds: 120
```

Each check takes a framework-specific `select` object, an optional project-relative `cwd`, and `timeoutSeconds` from 1 to 3600 seconds (default 120). Provide a filter or set `all: true` to run the whole suite in the chosen runner context. Match patterns and expressions use the runner's syntax.

`journey_status` starts a background attempt. Subsequent calls observe the same attempt while it runs. A failed check can retry on a later call. A successful exit with zero matching tests or only skipped tests leaves the check incomplete. Aborting the journey cancels its active test attempt.

| Check             | Selection fields                                   | Runner and setup                                                                                                                               |
| ----------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest.run`      | files, locations, namePattern, projects            | Vitest. Locations have file and line.                                                                                                          |
| `jest.run`        | files, namePattern, projects                       | Jest. Files use exact test paths.                                                                                                              |
| `node-test.run`   | files, namePattern                                 | Node's built-in test runner.                                                                                                                   |
| `mocha.run`       | files, titlePattern, titleIncludes                 | Mocha. Choose one title filter.                                                                                                                |
| `playwright.run`  | files, locations, titlePattern, projects           | Playwright. Title patterns can match tags.                                                                                                     |
| `cypress.run`     | specs, title, tags, browser, mode                  | Cypress. Title and tag filtering require the Cypress grep plugin and grepPlugin: true in the plugin options.                                   |
| `webdriverio.run` | specs, suites, namePattern, tags                   | WebdriverIO. Set config in plugin options if needed. Choose the Mocha or Jasmine adapter for name filtering and the Cucumber adapter for tags. |
| `pytest.run`      | paths, nodeIds, markers, keywords                  | Python pytest. Configure the virtual environment's Python executable if needed.                                                                |
| `unittest.run`    | names, startDirectory, filePattern, namePattern    | Python unittest. Choose dotted names or discovery settings.                                                                                    |
| `django.run`      | labels, tags, excludeTags                          | Django through manage.py test.                                                                                                                 |
| `junit.run`       | packages, classes, methods, suites, tags           | JUnit Platform Console Launcher. Configure the launcher command and classpath if needed.                                                       |
| `testng.run`      | suites, classes, methods, groups                   | Configure the TestNG CLI and classpath in the plugin command. Groups narrow the specified classes, methods, or suite.                          |
| `gradle.run`      | task, tests                                        | Gradle Test task. With a custom task and no test filters, use `all: true`.                                                                     |
| `maven.run`       | modules, tests, lifecycle                          | Maven. Select unit for Surefire or integration for Failsafe.                                                                                   |
| `cucumber.run`    | features, locations, namePattern, tags, profiles   | Set plugin implementation to js, jvm, or ruby. Configure the JVM launcher command explicitly.                                                  |
| `nunit.run`       | project, names, categories, filter                 | dotnet test with VSTest and the NUnit adapter.                                                                                                 |
| `xunit.run`       | project, names, traits, filter                     | dotnet test with VSTest and the xUnit adapter. Traits have name and value.                                                                     |
| `mstest.run`      | project, names, categories, filter                 | dotnet test with VSTest and the MSTest adapter.                                                                                                |
| `go-test.run`     | packages, namePattern                              | Go test. Supports slash-separated subtest patterns and reruns tests without the result cache.                                                  |
| `nextest.run`     | packages, binaries, names, filterset               | Cargo nextest.                                                                                                                                 |
| `rspec.run`       | files, locations, description, tags                | RSpec.                                                                                                                                         |
| `minitest.run`    | files, namePattern                                 | Minitest. Whole-suite runs require the project's test entry point in `options.command`.                                                        |
| `phpunit.run`     | paths, suites, groups, namePattern                 | Project-local PHPUnit.                                                                                                                         |
| `pest.run`        | paths, suites, groups, namePattern                 | Project-local Pest.                                                                                                                            |
| `ctest.run`       | buildDirectory, namePattern, labels, configuration | CTest with JUnit output support and a configured build directory.                                                                              |
| `googletest.run`  | executable, suites, cases, exclude                 | Compiled GoogleTest executable. Cases use Suite.Case patterns.                                                                                 |
| `flutter.run`     | paths, namePattern, nameIncludes, device           | Flutter test.                                                                                                                                  |
| `xctest.run`      | targets, classes, methods                          | Xcode with xcresulttool test-results support. Set scheme and optionally workspace, project, destination, or testPlan in plugin options.        |

The Appium plugin provides `appium.server-ready` with an optional `url` (default http://127.0.0.1:4723). Run mobile tests through their client framework, such as WebdriverIO or pytest.

## Evaluate existing reports

Each package registers its own `<framework>.passed` check. Run tests in the usual project command or CI job and retain the resulting report at the configured workspace path. Set `reports` to one path or a list of shard reports. Each check requires zero failures and at least one passing test by default. Set `minTests` and optionally `maxSkipped` to make the threshold stricter. For CI, provide reports produced by the revision being verified.

| Package names, under `@cairul`                                                          | Report format                                                                                                                                  |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `cypress-plugin`, `webdriverio-plugin`                                                  | JUnit XML                                                                                                                                      |
| `vitest-plugin`                                                                         | JUnit XML by default or the native report with `format: json`.                                                                                 |
| `jest-plugin`, `playwright-plugin`                                                      | Native JSON by default. Set `format: junit` for JUnit XML. Playwright's native JSON check counts flaky tests as failures.                      |
| `node-test-plugin`, `mocha-plugin`                                                      | Node defaults to TAP. Mocha defaults to JUnit-style XUnit XML and also accepts `format: tap`. For TAP, the check counts top-level TAP results. |
| `pytest-plugin`, `unittest-plugin`, `django-plugin`                                     | JUnit XML. Use a JUnit-compatible reporter for unittest or the Django test runner.                                                             |
| `junit-plugin`, `testng-plugin`, `gradle-plugin`, `maven-plugin`, `cucumber-plugin`     | JUnit XML. Use the JUnit XML output of your build tool or test reporter.                                                                       |
| `nunit-plugin`, `xunit-plugin`, `mstest-plugin`                                         | TRX from the .NET test runner. NUnit and xUnit also accept their native XML reports with `format: nunit` and `format: xunit`.                  |
| `go-test-plugin`, `nextest-plugin`                                                      | Go defaults to `go test -json` and also accepts `format: junit`. Nextest uses JUnit XML.                                                       |
| `rspec-plugin`, `minitest-plugin`, `phpunit-plugin`, `pest-plugin`                      | JUnit XML, using a compatible reporter where needed.                                                                                           |
| `ctest-plugin`, `googletest-plugin`, `xctest-plugin`, `appium-plugin`, `flutter-plugin` | JUnit XML. Convert native output or choose a JUnit reporter when your runner emits a different format.                                         |

Examples of producing reports:

```sh
pnpm exec vitest run --reporter=junit --outputFile=reports/vitest.xml
pnpm exec jest --ci --json --outputFile=reports/jest.json
PLAYWRIGHT_JSON_OUTPUT_FILE=reports/playwright.json pnpm exec playwright test --reporter=json
pytest --junitxml=reports/pytest.xml
go test -json ./... > reports/go.json
dotnet test --logger 'trx;LogFilePrefix=results' --results-directory reports
```

## Specialized gates

| Package           | Kind                      | Inputs                                                                                                               |
| ----------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `coverage-plugin` | `coverage.lcov-threshold` | LCOV `report`, percentage `minimum`, and optional `metric` (`lines`, `branches`, or `functions`).                    |
| `axe-plugin`      | `axe.violations`          | JSON `report` from axe, optional `impacts` and `maximum` violations.                                                 |
| `k6-plugin`       | `k6.thresholds-passed`    | JSON `report` written by `handleSummary`, with threshold evaluations in `metrics`.                                   |
| `pact-plugin`     | `pact.can-deploy`         | `pacticipant`, `version`, and `environment`. Configure the installed Pact Broker CLI with its usual broker settings. |
| `visual-plugin`   | `visual.pixel-diff`       | JSON `report` with `comparisons: [{differentPixels: 0}]` and optional `maximum` changed pixels per comparison.       |

## Plugin repositories

- [`@cairul/appium-plugin`](https://github.com/CairulMCP/cairul-appium-plugin)
- [`@cairul/asana-plugin`](https://github.com/CairulMCP/cairul-asana-plugin)
- [`@cairul/axe-plugin`](https://github.com/CairulMCP/cairul-axe-plugin)
- [`@cairul/azure-devops-plugin`](https://github.com/CairulMCP/cairul-azure-devops-plugin)
- [`@cairul/bitbucket-plugin`](https://github.com/CairulMCP/cairul-bitbucket-plugin)
- [`@cairul/clickup-plugin`](https://github.com/CairulMCP/cairul-clickup-plugin)
- [`@cairul/coverage-plugin`](https://github.com/CairulMCP/cairul-coverage-plugin)
- [`@cairul/ctest-plugin`](https://github.com/CairulMCP/cairul-ctest-plugin)
- [`@cairul/cucumber-plugin`](https://github.com/CairulMCP/cairul-cucumber-plugin)
- [`@cairul/cypress-plugin`](https://github.com/CairulMCP/cairul-cypress-plugin)
- [`@cairul/django-plugin`](https://github.com/CairulMCP/cairul-django-plugin)
- [`@cairul/flutter-plugin`](https://github.com/CairulMCP/cairul-flutter-plugin)
- [`@cairul/github-plugin`](https://github.com/CairulMCP/cairul-github-plugin)
- [`@cairul/gitlab-plugin`](https://github.com/CairulMCP/cairul-gitlab-plugin)
- [`@cairul/go-test-plugin`](https://github.com/CairulMCP/cairul-go-test-plugin)
- [`@cairul/googletest-plugin`](https://github.com/CairulMCP/cairul-googletest-plugin)
- [`@cairul/gradle-plugin`](https://github.com/CairulMCP/cairul-gradle-plugin)
- [`@cairul/jest-plugin`](https://github.com/CairulMCP/cairul-jest-plugin)
- [`@cairul/jira-plugin`](https://github.com/CairulMCP/cairul-jira-plugin)
- [`@cairul/junit-plugin`](https://github.com/CairulMCP/cairul-junit-plugin)
- [`@cairul/k6-plugin`](https://github.com/CairulMCP/cairul-k6-plugin)
- [`@cairul/linear-plugin`](https://github.com/CairulMCP/cairul-linear-plugin)
- [`@cairul/maven-plugin`](https://github.com/CairulMCP/cairul-maven-plugin)
- [`@cairul/minitest-plugin`](https://github.com/CairulMCP/cairul-minitest-plugin)
- [`@cairul/mocha-plugin`](https://github.com/CairulMCP/cairul-mocha-plugin)
- [`@cairul/monday-plugin`](https://github.com/CairulMCP/cairul-monday-plugin)
- [`@cairul/mstest-plugin`](https://github.com/CairulMCP/cairul-mstest-plugin)
- [`@cairul/nextest-plugin`](https://github.com/CairulMCP/cairul-nextest-plugin)
- [`@cairul/node-test-plugin`](https://github.com/CairulMCP/cairul-node-test-plugin)
- [`@cairul/notion-plugin`](https://github.com/CairulMCP/cairul-notion-plugin)
- [`@cairul/nunit-plugin`](https://github.com/CairulMCP/cairul-nunit-plugin)
- [`@cairul/pact-plugin`](https://github.com/CairulMCP/cairul-pact-plugin)
- [`@cairul/perforce-plugin`](https://github.com/CairulMCP/cairul-perforce-plugin)
- [`@cairul/pest-plugin`](https://github.com/CairulMCP/cairul-pest-plugin)
- [`@cairul/phpunit-plugin`](https://github.com/CairulMCP/cairul-phpunit-plugin)
- [`@cairul/playwright-plugin`](https://github.com/CairulMCP/cairul-playwright-plugin)
- [`@cairul/pytest-plugin`](https://github.com/CairulMCP/cairul-pytest-plugin)
- [`@cairul/rspec-plugin`](https://github.com/CairulMCP/cairul-rspec-plugin)
- [`@cairul/testng-plugin`](https://github.com/CairulMCP/cairul-testng-plugin)
- [`@cairul/trello-plugin`](https://github.com/CairulMCP/cairul-trello-plugin)
- [`@cairul/unittest-plugin`](https://github.com/CairulMCP/cairul-unittest-plugin)
- [`@cairul/visual-plugin`](https://github.com/CairulMCP/cairul-visual-plugin)
- [`@cairul/vitest-plugin`](https://github.com/CairulMCP/cairul-vitest-plugin)
- [`@cairul/webdriverio-plugin`](https://github.com/CairulMCP/cairul-webdriverio-plugin)
- [`@cairul/workspace-plugin`](https://github.com/CairulMCP/cairul-workspace-plugin)
- [`@cairul/xctest-plugin`](https://github.com/CairulMCP/cairul-xctest-plugin)
- [`@cairul/xunit-plugin`](https://github.com/CairulMCP/cairul-xunit-plugin)
- [`@cairul/youtrack-plugin`](https://github.com/CairulMCP/cairul-youtrack-plugin)
