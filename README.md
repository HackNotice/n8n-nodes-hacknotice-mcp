# n8n-nodes-hacknotice-mcp

[n8n](https://n8n.io/) community package: **HackNotice MCP Client** — connect workflows and **AI Agents** to tools exposed by [HackNotice](https://hacknotice.com/)'s MCP server using the Model Context Protocol ([MCP](https://modelcontextprotocol.io/)) over **Streamable HTTP**.

This package is intentionally **separate** from [n8n-nodes-hacknotice-api](https://github.com/HackNotice/n8n-nodes-hacknotice) (HTTP REST alerts), per n8n community-node publishing rules: MCP tool nodes must not ship in the same npm package as the main HTTP integration.

## Relation to n8n's MCP Client Tool

n8n's built-in **[MCP Client Tool](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/)** sub-node is the reference pattern: credentials, tool discovery, and `usableAsTool` for agents. That node connects via an **SSE endpoint** and supports bearer / header / OAuth2. This community node targets HackNotice's **Streamable HTTP** `/mcp` URL and **HackNotice MCP API** credentials (integration key header). Behavior in workflows (list tools, call tool, agent tool use) is analogous.

## Installation

Follow the [community nodes installation guide](https://docs.n8n.io/integrations/community-nodes/installation/). npm package name: **`n8n-nodes-hacknotice-mcp`**.

## Credentials

In n8n, create **HackNotice MCP API** and set **Integration Key** (per-user secret). You can create or copy an integration key from [HackNotice app preferences](https://app.hacknotice.com/#/preferences). The key is sent as `X-HackNotice-Integration-Key` on every MCP request.

## Node operations

- **List Tools** — one item per tool (`tools/list` from the live server).
- **Call Tool** — `tools/call` with JSON arguments; optional **Fail on MCP Tool Error** for Error Workflows.

## AI Agent usage

- Enable **Fail on MCP Tool Error** for reliable failure signaling.
- Test **Call Tool** with a fixed tool name and `{}` arguments before wiring an AI Agent.

## Example workflow (smoke test)

1. Add **Manual Trigger** → **HackNotice MCP Client**.
2. Attach **HackNotice MCP API** credentials.
3. Run **List Tools** and execute once to confirm connectivity and auth.
4. Switch to **Call Tool**, pick a tool, set **Arguments (JSON)** to `{}` or values that match the tool schema, then execute.

## Compatibility

- Use a current [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/installation/)–compatible release. This package declares a peer dependency on `n8n-workflow` (provided by the host).
- For local development with `npm run dev`, use **Node.js 22+** as recommended by the [n8n nodes starter](https://github.com/n8n-io/n8n-nodes-starter).

## Verification checklist (n8n Cloud)

This package is structured to align with [Community node verification guidelines](https://docs.n8n.io/integrations/creating-nodes/build/reference/verification-guidelines/):


| Guideline                          | How this package complies                                                                                                                                                                                                        |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **n8n-node tool**                  | Scaffolded and maintained with [@n8n/node-cli](https://github.com/n8n-io/n8n-nodes-starter); run `npm run lint` and `npm run build` before release.                                                                            |
| **Node types**                     | Not a duplicate of a built-in node; not generic flow-control. One third-party surface: **HackNotice MCP** (HTTP node for REST alerts lives in [n8n-nodes-hacknotice-api](https://github.com/HackNotice/n8n-nodes-hacknotice)). |
| **Package source**                 | Public GitHub: [HackNotice/n8n-nodes-hacknotice-mcp](https://github.com/HackNotice/n8n-nodes-hacknotice-mcp). `package.json` `repository`, `homepage`, and npm metadata should match that repo and maintainer.                   |
| **MIT license**                    | See [LICENSE.md](LICENSE.md).                                                                                                                                                                                                    |
| **Provenance (May 2026+)**         | Publish via GitHub Actions with npm provenance — see [.github/workflows/publish.yml](.github/workflows/publish.yml).                                                                                                           |
| **No runtime `dependencies`**      | `dependencies` in `package.json` is empty; only `n8n-workflow` is listed as a **peer** (supplied by n8n).                                                                                                                        |
| **Documentation**                  | This README, credential descriptions in the editor, and links to HackNotice / MCP / n8n docs below.                                                                                                                              |
| **No env / filesystem for config** | Node logic does not read `process.env` or read/write the host filesystem for configuration; only n8n parameters and stored credentials are used. Outbound traffic uses n8n's HTTP helpers to the fixed MCP URL above.            |
| **English**                        | UI copy and this README are in English.                                                                                                                                                                                          |

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
   - **Trusted publishing (recommended):** On [npmjs.com](https://www.npmjs.com/) → package **Settings** → **Trusted Publishers** → add **GitHub Actions** with repository `HackNotice/n8n-nodes-hacknotice-mcp` and workflow file **`publish.yml`**. Leave the `NPM_TOKEN` repo secret unset.  
   - **Token fallback:** Create a granular **Read and write** token for this package, then add repo secret **`NPM_TOKEN`** in GitHub (**Settings → Secrets and variables → Actions**).

2. **Cut a release** (from a clean `main` with upstream set): run **`npm run release`**, choose the version, and let `release-it` commit, tag, and push. The tag push triggers the workflow; in CI, `n8n-node release` runs `lint`, `build`, and **`npm publish`** with provenance.

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

