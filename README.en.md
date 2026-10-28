# TraceLogDock

[简体中文](README.md) · [Documentation](docs/README.md) · [Architecture](docs/architecture.md) · [Roadmap](docs/roadmap.md)

A desktop workbench for Docker logs and Arthas diagnostics across multiple Java microservice projects and servers.

> **Private project. External contributions and Issues are not accepted. Version 0.1.0 is a local desktop foundation.** Project, environment, server and service configuration, independent workspace windows, local persistence, and command previews are implemented. SSH authentication, live log streams, automatic method search, and remote diagnostics remain planned. No production-ready signed installer is available.

## Product direction and current scope

- Open independent project workspaces in multiple windows.
- Connect through direct SSH or JumpServer SSH with interactive MFA and asset selection.
- Discover Docker containers and confirm service-to-instance mappings.
- Combine logs from selected instances while preserving server and instance identity.
- Search loaded Java methods and run trace, watch, monitor, and stack templates.
- Track and stop instance-specific tasks without disrupting other workspaces.

macOS is the initial target. Windows, SLS historical queries, and structured diagnostic views are later milestones. The local configuration and multi-window foundation is implemented; remote features remain pending. Current status and acceptance criteria are maintained in the [roadmap](docs/roadmap.md).

## Technical direction

Electron, Vue 3, TypeScript, and Zod are implemented dependencies. ssh2 and xterm.js remain planned integration choices. Connections, credentials, and task ownership live in the main process. Project windows access a narrowly scoped IPC API. See the [architecture](docs/architecture.md) and [decision records](docs/adr/README.md).

A workspace is organized as project → environment → service → instance. Connection mode belongs to each server, allowing direct SSH and JumpServer targets within the same project.

## Maintaining this project

Use Node.js 22 or a newer supported release, pnpm 10.28.1, and Git.

```bash
corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

Corepack may need to be installed separately depending on your Node.js distribution. Use `pnpm build` and `pnpm start` for a built application. `pnpm package:mac` produces an unsigned local test app, not a published signed release. See the [development guide](docs/development.md) for repository conventions.

Most detailed documentation is currently in Simplified Chinese. The repository is maintained by its owner and does not accept external contributions, Issues, or external Pull Requests.

## Integration boundaries

Docker log access does not imply permission to execute commands, transfer files, or attach to a JVM. JumpServer concurrency, MFA reuse, and forwarding depend on the actual deployment. Arthas must be loaded into the target JVM; trace is not distributed tracing or historical call reconstruction. A disconnected local channel does not prove a remote diagnostic task has stopped.

Never submit real credentials, production addresses, customer logs, or internal terminal screenshots. Report vulnerabilities using the [security policy](SECURITY.md).

## Rights

All rights reserved. This project is not currently open source; see [LICENSE](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md). This is an independent project and is not officially affiliated with Arthas, JumpServer, or Docker.
