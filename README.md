# n8n-nodes-hacknotice-mcp

[n8n](https://n8n.io/) community package: **HackNotice MCP Client** — connect workflows and **AI Agents** to tools exposed by [HackNotice](https://hacknotice.com/)'s MCP server using the Model Context Protocol ([MCP](https://modelcontextprotocol.io/)) over **Streamable HTTP**.

This package is intentionally **separate** from [n8n-nodes-hacknotice-api](https://github.com/HackNotice/n8n-nodes-hacknotice) (HTTP REST alerts), per n8n community-node publishing rules: MCP tool nodes must not ship in the same npm package as the main HTTP integration.

## Relation to n8n's MCP Client Tool

n8n's built-in **[MCP Client Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/)** sub-node is the reference pattern for exposing MCP tools to AI Agents. This community node is purpose-built for HackNotice:

- It uses HackNotice's fixed **Streamable HTTP** `/mcp` endpoint.
- It authenticates with a HackNotice **Integration Key** credential.
- It connects only to the AI Agent **Tool** input.
- It lets users choose whether to expose all MCP tools, only selected tools, all except selected tools, or tools by functional group.

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/). npm package name: `**n8n-nodes-hacknotice-mcp`**.

## Credentials

In n8n, create **HackNotice MCP API** and set **Integration Key** (per-user secret). You can create or copy an integration key from [HackNotice app preferences](https://app.hacknotice.com/#/preferences). The key is sent as `X-HackNotice-Integration-Key` on every MCP request.

## Node Behavior

**HackNotice MCP** is an AI Agent tool node. It has no regular Main input/output branch and is not intended to be run as a standalone canvas step.

Connect it to an **AI Agent** node's **Tool** input. At execution time it:

1. Fetches the live HackNotice MCP tool catalogue with `tools/list`.
2. Caches that catalogue per Integration Key for 5 minutes.
3. Exposes the configured tool set to the AI Agent.
4. Executes requested tools through MCP `tools/call`.

The node includes the `execute()` implementation required by n8n's v3 AI Agent engine, so tool calls are recorded in n8n executions and the node turns green when invoked.

## AI Agent Usage

Create a workflow like:

1. **When chat message received**
2. **OpenAI Chat Model** connected to the AI Agent's **Chat Model** input
3. **AI Agent**
4. **HackNotice MCP** connected to the AI Agent's **Tool** input

Use **Tools to Expose** to control which MCP tools are available to the AI Agent.

### Tools to Expose


| Mode                    | Behavior                                                                   |
| ----------------------- | -------------------------------------------------------------------------- |
| **All**                 | Exposes the full live MCP catalogue. This is the default.                  |
| **Selected**            | Exposes only the tools selected in **Tools to Include**.                   |
| **All Except Selected** | Exposes every live MCP tool except those selected in **Tools to Exclude**. |
| **By Group**            | Exposes tools from the functional groups selected in **Tool Groups**.      |


The **Tools to Include** and **Tools to Exclude** fields load their options from the live HackNotice MCP server with `tools/list`, so they stay aligned with the server catalogue.

### By Group

**Tool Groups** is a fixed, multi-select list of HackNotice's functional tool families — pick one or more:

- **Third-Party** — third-party vendor breach alerts and watchlist management (`hacknotice_third_party_*`)
- **First-Party** — first-party domain breach alerts and watchlist management (`hacknotice_first_party_*`)
- **End User** — end-user credential alerts and watchlist management (`hacknotice_end_user_*`)
- **Research** — research phrase and wordpool alerts (`hacknotice_research_*`)
- **Assessments** — vendor security assessments, invites, templates, and data files (`hacknotice_assessment_*`)

General/search tools that don't belong to a single group (credential verification, saved searches, and the global breach/exposure/chatter/leaked-file/correlated-leak search tools) are always exposed in **By Group** mode, regardless of which groups are selected, since an agent typically needs search capability no matter which functional area it's working in.

### Debug Mode

Turn on **Debug Mode** in the HackNotice MCP node to force `debug: true` on every MCP tool call.

When enabled, tool responses include `_debug` with redacted request/response trace data from:

- the inbound MCP request,
- outbound HackNotice API requests,
- outbound HackNotice API responses.

This is useful for validating the full flow from n8n prompt to MCP server to HackNotice API.

### Prompting Tips

Examples:

- `give me the alerts from my thirdparty watchlist`
- `give me the alerts from my first party watchlist`
- `search global breaches for acme.com`
- `find credential leaks for example.com`
- `search leaked files for Acme spreadsheets`

For best results with the AI Agent, expose only the tool families needed by your workflow. For example, a third-party alert workflow can use **Selected** mode with `hacknotice_third_party_alerts` and watchlist tools.

The built-in **[MCP Client Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/)** route can also connect to HackNotice's endpoint if you prefer the generic n8n MCP node:


| Setting          | Value                                  |
| ---------------- | -------------------------------------- |
| Endpoint         | `https://mcp.hacknotice.com:13330/mcp` |
| Transport        | HTTP Streamable                        |
| Authentication   | Header Auth                            |
| Header name      | `X-HackNotice-Integration-Key`         |
| Header value     | Your HackNotice integration key        |
| Tools to Include | Selected or All                        |


## Example workflows


| Workflow                                         | File                                                                                                 | Purpose                                                  |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Community node review** (submit to boss / n8n) | `[examples/community-node-review.workflow.json](examples/community-node-review.workflow.json)`       | Basic reviewer workflow for confirming package setup     |
| **AI Agent (chat)**                              | `[examples/ai-agent-mcp-client-tool.workflow.json](examples/ai-agent-mcp-client-tool.workflow.json)` | Chat + AI Agent + HackNotice MCP connected as an AI tool |


See **[SUBMISSION.md](SUBMISSION.md)** for reviewer steps and checklist.

### Quick Smoke Test

1. Add **When chat message received**.
2. Add **AI Agent** and connect an OpenAI-compatible Chat Model.
3. Add **HackNotice MCP** and connect it to the AI Agent **Tool** input.
4. Attach **HackNotice MCP API** credentials.
5. Keep **Tools to Expose** set to **All**, or choose **Selected** and include the tools you want the agent to use.
6. Send a prompt that maps to one of the exposed tools, for example: `search global breaches for acme.com`.

The HackNotice MCP node should appear as executed in the n8n execution log when the agent calls a tool.

## Compatibility

- Use a current [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/installation/)–compatible release. This package declares a peer dependency on `n8n-workflow` (provided by the host).
- For local development with `npm run dev`, use **Node.js 22+** as recommended by the [n8n nodes starter](https://github.com/n8n-io/n8n-nodes-starter).

## Verification checklist (n8n Cloud)

This package is structured to align with [Community node verification guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/):


| Guideline                          | How this package complies                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **n8n-node tool**                  | Scaffolded and maintained with [@n8n/node-cli](https://github.com/n8n-io/n8n-nodes-starter); run `npm run lint` and `npm run build` before release.                                                                            |
| **Node types**                     | Not a duplicate of a built-in node; not generic flow-control. One third-party surface: **HackNotice MCP** (HTTP node for REST alerts lives in [n8n-nodes-hacknotice-api](https://github.com/HackNotice/n8n-nodes-hacknotice)). |
| **Package source**                 | Public GitHub: [HackNotice/n8n-nodes-hacknotice-mcp](https://github.com/HackNotice/n8n-nodes-hacknotice-mcp). `package.json` `repository`, `homepage`, and npm metadata should match that repo and maintainer.                 |
| **MIT license**                    | See [LICENSE.md](LICENSE.md).                                                                                                                                                                                                  |
| **Provenance (May 2026+)**         | Publish via GitHub Actions with npm provenance — see [.github/workflows/publish.yml](.github/workflows/publish.yml).                                                                                                           |
| **No runtime `dependencies`**      | `dependencies` in `package.json` is empty; only `n8n-workflow` is listed as a **peer** (supplied by n8n).                                                                                                                      |
| **Documentation**                  | This README, credential descriptions in the editor, and links to HackNotice / MCP / n8n docs below.                                                                                                                            |
| **No env / filesystem for config** | Node logic does not read `process.env` or read/write the host filesystem for configuration; only n8n parameters and stored credentials are used. Outbound traffic uses n8n's HTTP helpers to the fixed MCP URL above.          |
| **English**                        | UI copy and this README are in English.                                                                                                                                                                                        |


### `@n8n/scan-community-package` (registry scan)

That CLI **always downloads your package from the [npm registry](https://www.npmjs.com/)**: it loads the package metadata, then runs `npm pack` and ESLint on the unpacked tarball.

- **If you see `404` / `Request failed with status code 404`:** the package name is not published on npm yet (or the name is wrong). This is expected **before your first `npm publish` / GitHub Actions release**.
- **After the package exists on npm**, run (optionally pin a version):
  ```bash
  npx @n8n/scan-community-package n8n-nodes-hacknotice-mcp
  # or, e.g.:
  npx @n8n/scan-community-package n8n-nodes-hacknotice-mcp@1.0.0
  ```
- **Before publish**, use the same checks locally: `npm run lint` and `npm run build` (via `@n8n/node-cli`), which align with n8n’s verification expectations.

## Submitting for verification

- [n8n Creator Portal](https://creators.n8n.io/)
- [Verification guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/)

## Publishing with GitHub Actions

Releases are published to npm from the **Publish** workflow when a **version tag** is pushed (for example `v1.0.2` from `release-it`).

1. **One-time npm setup (pick one)**
  - **Trusted publishing (recommended):** On [npmjs.com](https://www.npmjs.com/) → package **Settings** → **Trusted Publishers** → add **GitHub Actions** with repository `HackNotice/n8n-nodes-hacknotice-mcp` and workflow file `**publish.yml`**. Leave the `NPM_TOKEN` repo secret unset.  
  - **Token fallback:** Create a granular **Read and write** token for this package, then add repo secret `**NPM_TOKEN`** in GitHub (**Settings → Secrets and variables → Actions**).
2. **Cut a release** (from a clean `main` with upstream set): run `**npm run release`**, choose the version, and let `release-it` commit, tag, and push. The tag push triggers the workflow; in CI, `n8n-node release` runs `lint`, `build`, and `**npm publish**` with provenance.
3. **Re-run a failed publish** without a new version: **Actions → Publish → Run workflow**, select the **tag** you want to publish (must match `version` in `package.json` on that commit), then run.

See [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers) and the comments in [.github/workflows/publish.yml](.github/workflows/publish.yml).

## Development

Uses [@n8n/node-cli](https://github.com/n8n-io/n8n-nodes-starter) like the official starter:

```bash
npm install
npm run dev
npm run lint
npm run build
```

## License

MIT — see [LICENSE.md](LICENSE.md).

## Resources

- [Building community nodes](https://docs.n8n.io/integrations/community-nodes/build-community-nodes/)
- [MCP Client Tool (built-in) — reference UX](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- Issues: [github.com/HackNotice/n8n-nodes-hacknotice-mcp/issues](https://github.com/HackNotice/n8n-nodes-hacknotice-mcp/issues)

