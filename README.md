# Cairul

Cairul gives agents a plan and checks what needs to be true before work is complete. This repository contains the [stdio MCP server](apps/mcp), [Codex plugin](plugins/cairul), and [TypeScript SDK](packages/sdk). The MCP runs journeys locally by default, using YAML plans and checks from your project. The developer feature set builds on the same journey engine with GitHub issue and pull request checks, CI checks, and workflows for application development. The hosted service lives in [Cairul Internal](https://github.com/CairulMCP/cairul-internal).

## Install from source

Clone with submodules and use Node.js 24 or newer and the pnpm version pinned in `package.json`.

```sh
git clone --recurse-submodules https://github.com/CairulMCP/cairul.git
cd cairul
```

For an existing checkout, run `git submodule update --init --recursive`. Then install and build from the repository root.

```sh
pnpm install --frozen-lockfile
pnpm build
```

The Codex plugin installs the `cairul-journey` skill and registers `cairul-mcp` as a stdio server. Put the launcher on the `PATH` used by Codex and add the local plugin marketplace.

```sh
mkdir -p "$HOME/.local/bin"
ln -s "$PWD/apps/mcp/bin/cairul-mcp.mjs" "$HOME/.local/bin/cairul-mcp"
export PATH="$HOME/.local/bin:$PATH"
codex plugin marketplace add "$PWD"
codex plugin add cairul@cairul
```

Start a new Codex session with that `PATH`. For another MCP harness, set the command to `node` and pass the absolute path to `apps/mcp/dist/index.js` as its argument.

## Run a journey

A journey pins its plan, including instructions and ordered phases. Checks in a phase can finish in any order.

Pass the agent harness's session ID and an HTTP or HTTPS work-item URL to `journey_start`. cairul selects the plan from the URL and creates the journey and its identity together. Codex callers can use `CODEX_SESSION_ID` when available, or `CODEX_THREAD_ID` for a top-level session. The MCP supplies the Codex thread and version from call metadata when available.

```json
{ "session_id": "1e9a49ba-5074-4eea-acca-8b740b6bedec", "work_item_url": "https://github.com/acme/service/issues/42" }
```

### Local configuration

Cairul searches the harness's working directory and its parents for the nearest `.cairul` directory. If none exists, it uses the nearest Git root or the harness's working directory. Set `CAIRUL_PROJECT_DIR` to an absolute path to choose where the search starts. Each new journey stores its effective plan, state, and copies of the config files under `.cairul/journeys/<journey-id>/`. Add `.cairul/journeys/` to the project's ignore list to keep run state out of version control. Existing `KAIR0_*` launch variables are accepted when the corresponding `CAIRUL_*` variables are unset.

Projects with an existing `.kair0`, `.nauxt`, or `.minerva` directory can rename it to `.cairul` to keep their configuration and journeys. Cairul also reads the existing directory when `.cairul` is absent.

Define reusable checks in `.cairul/checks.yaml`. Give each check a unique name, select a check kind, and pass its inputs under `options`.

```yaml
checks:
  - name: Project checks
    kind: shell.command
    options:
      command: pnpm check
```

In `.cairul/plans.yaml`, list work-item URL patterns and the phases for each plan. A phase can reference checks by name and define checks inline. Inline checks belong to that phase, and check names must be unique within the phase.

```yaml
plans:
  - match: 'https://github.com/acme/service/issues/*'
    name: Service issue
    mode: extend
    instructions: Run project checks before completing the journey.
    phases:
      - name: Verify
        checks:
          - Project checks
          - name: Clean worktree
            command: git diff --quiet
  - match: '*'
    phases:
      - name: Verify
        checks: [Project checks]
```

Either file can use the `.yml` extension. A check with just `name` and `command` expands to `kind: shell.command` with `options.command`. The shorthand works in either file. cairul selects the longest matching literal prefix. A quoted `'*'` matches every URL. In local mode, cairul uses a single phase with no checks when no plan matches.

`journey_status` evaluates pending checks using the inputs pinned when the journey started. The built-in `shell.command` kind runs from the project directory with the MCP process's environment and permissions. Exit code zero passes the check for that journey. Failures stay pending and report the latest outcome. The next status call retries failed checks. Each command has up to 15 seconds within a 25-second local check budget per status call. Use shell commands from project configuration you trust.

| MCP tool           | Inputs                        | Result                                                           |
| ------------------ | ----------------------------- | ---------------------------------------------------------------- |
| `journey_start`    | `session_id`, `work_item_url` | Pins the plan and returns the journey ID.                        |
| `journey_status`   | `journey_id`                  | Runs pending checks and reports the current phase and readiness. |
| `journey_complete` | `journey_id`                  | Completes a journey after its final phase passes.                |
| `journey_abort`    | `journey_id`                  | Aborts an active journey.                                        |
| `cairul_health`    | None                          | Reports MCP health and checks the backend when enabled.          |

### Local plugins

The Cairul Plugin Development Kit (PDK) provides helpers for defining checks, running tests, and reading reports. Plugin authors can install it as `@cairul/pdk`.

Browse the [integration catalog](packages/README.md) for work trackers, source control, test frameworks, and report gates. Install the packages you need as project dependencies and list them in `.cairul/plugins.yaml`. Plugin-level `options` go to the factory. Check-level `options` go to the kind's validator and runner.

```yaml
plugins:
  - package: '@cairul/github-plugin'
    options:
      tokenEnv: GITHUB_TOKEN
  - package: '@cairul/vitest-plugin'
```

The local MCP resolves packages from the project directory. At startup, it loads plugins for `CAIRUL_PROJECT_DIR` or its working directory. If the harness supplies a different project when a journey is requested, the MCP loads that project's plugins on first use. Restart the MCP to reload plugin configuration. Packages run inside the MCP process with its permissions, so use packages and project configuration you trust.

A plugin's default export is a sync or async factory. It returns an object with a `checkKinds` map keyed by namespaced kind names. Each kind provides `run(options, context)` and can provide `validate(options)`. Validation throws when the check options are invalid. The runner receives `projectDir`, `workItemUrl`, and an abort `signal` in its context. Return `{ status: 'passed' | 'pending' | 'error', detail?: string }` and honor the signal to stop in-progress work. Reserve standard output for MCP messages. The MCP sends `console.log` and other console output to standard error.

```js
export default function plugin({ organization }) {
  if (typeof organization !== 'string') throw new Error('organization is required');

  return {
    checkKinds: {
      'example.work-item-host': {
        validate({ hostname }) {
          if (typeof hostname !== 'string') throw new Error('hostname is required');
        },
        run({ hostname }, { workItemUrl }) {
          const url = new URL(workItemUrl);
          return url.hostname === hostname && url.pathname.startsWith(`/${organization}/`)
            ? { status: 'passed' }
            : { status: 'pending', detail: 'Work item is outside the configured organization.' };
        },
      },
    },
  };
}
```

## Connect to Cairul

Set `CAIRUL_BACKEND_ENABLED=true` and `CAIRUL_API_URL` in the harness launch environment to connect to a compatible Cairul backend. The URL defaults to `http://127.0.0.1:8080` in backend mode. A local plan with `mode: extend` adds instructions and checks to the backend plan. A check in `checks.yaml` with the same name as a backend check replaces it with a local check. Give inline checks a different name from backend checks in the same phase. Use `mode: override` to run a matching plan entirely locally.

In Codex, backend-linked journeys publish observations such as tool names, outcomes, timing, and token counts. The observation payload omits prompts, assistant text, and tool arguments and results. Set `CAIRUL_TELEMETRY=false` to disable observation collection. The plugin forwards these settings along with `CAIRUL_PROJECT_DIR`, `CAIRUL_HARNESS`, `CAIRUL_LOG_LEVEL`, and `CODEX_HOME` when set.

## Development

Run `pnpm check` to lint, build, and test the workspace. The tests exercise local journeys through the plugin launcher and SDK-backed health checks against a test HTTP server. For the full backend integration suite, set `CAIRUL_TEST_API_BIN` to the absolute path of a compatible Cairul API executable and run `pnpm test`.

### Regenerate the SDK

The SDK is a TypeScript Fetch client. The generated source is checked in, so ordinary builds work without a running backend. To update it, install Java 21 or newer, start the backend with the updated OpenAPI spec, and run these commands from this repository root.

```sh
export CAIRUL_OPENAPI_URL=http://127.0.0.1:8080/openapi.json
pnpm generate
pnpm build
```

`CAIRUL_OPENAPI_URL` is the full HTTP or HTTPS URL of the OpenAPI JSON document. Run `pnpm generate:check` with the same URL to check for drift. The MCP depends on the SDK through the pnpm workspace, so the build picks up the regenerated client automatically.

## License

The code in this repository is available under the [Apache License 2.0](LICENSE). The cairul SaaS offering is distributed separately under its own terms.

## CI and releases

GitHub Actions runs lint, builds, package tests, and a Trivy filesystem scan on pushes and pull requests to `main`. Trivy fails the check on high or critical dependency vulnerabilities, secrets, or configuration findings. Tests that need the internal API run when `CAIRUL_TEST_API_BIN` is set. The default GitHub workflow runs the local and mocked tests.

Release Please opens separate MCP, SDK, and PDK release PRs from conventional commits on `main`. Each PR bumps its own package and manifest entry. Each integration has its own release workflow in its plugin repository.

Configure these values in the GitHub repository to enable releases.

- `RELEASE_PLEASE_TOKEN` GitHub Actions secret. Use a GitHub fine-grained PAT with Contents, Pull requests, and Issues read/write access on the repositories it releases. An organization secret can supply the credential to the core and plugin repositories. This lets CI run automatically when Release Please opens or updates its PR.
- npm trusted publishing for `@cairul/mcp`, `@cairul/pdk`, and `@cairul/sdk`. Configure `cairul-hq/cairul`, `release.yaml`, and environment `npm` for each package on npm. The release job authenticates via GitHub OIDC and attaches provenance.
- `NPM_ACCESS` repository variable (optional). The default is `public`, so standalone integrations can install the shared PDK.

Publish the SDK version on `main` before merging an MCP release PR. The MCP depends on that exact SDK version in its npm archive, and CI checks that the SDK is available. Publish the PDK before merging standalone plugin releases.

Once a release PR is merged and its exact `main` commit passes CI, the release workflow publishes that commit's tagged packages. It packs workspace dependency references into registry-ready versions, publishes dependencies first, and skips versions already present in npm. To retry a failed publish after tags exist, rerun the failed job or dispatch the Release workflow from `main` with the original CI-approved commit SHA.
