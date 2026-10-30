# TraceLogDock

[简体中文](README.md) · [Documentation](docs/README.md) · [Architecture](docs/architecture.md) · [Roadmap](docs/roadmap.md)

A desktop workbench for Docker logs and Arthas diagnostics across multiple Java microservice projects and servers.

> **Private project. External contributions and Issues are not accepted. Version 0.3.20 enlarges the log viewer and scales it with window height; server configuration opens first, the SERVICES list has edit/delete actions, and time ranges, AI settings, runtime-source inspection and local suggestions remain available.** Password/private-key SSH, host trust, interactive MFA, an embedded terminal, manual JumpServer target selection/confirmation, shared authentication with independent target PTYs (where supported), container discovery, and live multi-instance logs are implemented. Remote flows have been tested against isolated local SSH fixtures, not a production JumpServer deployment or Docker engine. JVM discovery, attachment using an existing or automatically downloaded Arthas 4.0.5 distribution, method search, ClassLoader-aware templates, raw results and per-task interruption are implemented. Docker/JVM attachment compatibility remains unverified. No production signed installer is available.

## Product direction and current scope

- Open independent project workspaces in multiple windows.
- Connect through direct SSH or JumpServer SSH with interactive MFA and asset selection.
- Discover Docker containers and confirm service-to-instance mappings.
- Combine logs from selected instances while preserving server and instance identity.
- Search loaded Java methods and run trace, watch, monitor, and stack templates.
- Track and stop instance-specific tasks without disrupting other workspaces.

macOS is the validated desktop target. Windows x64 has an NSIS build entry, with native installation/runtime acceptance pending; SLS historical queries remain a later milestone. Workspaces, SSH/MFA terminals, container discovery and live Docker log workflows are implemented; Arthas package detection/download workflows are implemented, with real deployment validation pending. Current status and acceptance criteria are maintained in the [roadmap](docs/roadmap.md).

## Technical direction

Electron, Vue 3, TypeScript, Zod, ssh2, and xterm.js are runtime/build dependencies. Connections, credentials, and task ownership live in the main process. Project windows access a narrowly scoped IPC API. See the [architecture](docs/architecture.md) and [decision records](docs/adr/README.md).

A workspace is organized as project → environment → service → instance. Connection mode belongs to each server, allowing direct SSH and JumpServer targets within the same project.

## Install and use

See the [Mac and Windows installation guide](docs/installation.md) for setup, installation, upgrades, server configuration, logs, diagnostics and AI settings.

| Platform          | Build command                 | Output                                           |
| ----------------- | ----------------------------- | ------------------------------------------------ |
| Apple Silicon Mac | `pnpm package:mac`            | `dist/mac-arm64/TraceLogDock.app`                |
| Windows 10/11 x64 | `pnpm package:win` on Windows | `dist/windows/TraceLogDock-Setup-0.3.20-x64.exe` |

Install dependencies with `pnpm install --frozen-lockfile` before building. End users do not need Node.js or pnpm. Installers are not committed to Git, and there is no GitHub Release download yet. Mac builds are ad-hoc signed test apps; native Windows installation/runtime acceptance is pending.

## Maintaining this project

Use Node.js 22 or a newer supported release, pnpm 10.28.1, and Git.

```bash
corepack enable
corepack prepare pnpm@10.28.1 --activate
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

Corepack may need to be installed separately depending on your Node.js distribution. Use `pnpm build` and `pnpm start` for a built application. `pnpm package:win` generates a Windows x64 NSIS installer under `dist/windows`; Windows installation/runtime acceptance is still pending. `pnpm package:mac` produces an ad-hoc signed local test app, not a notarized release. See the [development guide](docs/development.md) for repository conventions.

Most detailed documentation is currently in Simplified Chinese. The repository is maintained by its owner and does not accept external contributions, Issues, or external Pull Requests.

## Integration boundaries

Docker log access does not imply permission to execute commands, transfer files, or attach to a JVM. JumpServer concurrency, MFA reuse, and forwarding depend on the actual deployment. Arthas must be loaded into the target JVM; trace is not distributed tracing or historical call reconstruction. A disconnected local channel does not prove a remote diagnostic task has stopped.

Never submit real credentials, production addresses, customer logs, or internal terminal screenshots. Report vulnerabilities using the [security policy](SECURITY.md).

## Rights

All rights reserved. This project is not currently open source; see [LICENSE](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md). This is an independent project and is not officially affiliated with Arthas, JumpServer, or Docker.
