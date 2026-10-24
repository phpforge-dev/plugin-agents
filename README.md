# Agents plugin

Independent PHPForge workbench package, extracted from the MIT PHP IDE implementation. Requires IDE 0.2.13 and explicit project.read/workbench/process consent.

Owns feature UI, interaction workflows and rendering. The host currently brokers the declared operations in plugin.json. Feature-specific Rust backend extraction is tracked separately; this package does not claim an independently unloadable backend. No Node runtime is used in the IDE.

Build and validate: `npm ci --ignore-scripts`, `npm test`, `npm run build`. Prebuilt browser assets are committed. Disable removes owned UI, listeners and polling. Native process access remains governed by host permissions.

## Native feature library

`native/` owns the agents feature implementation and protocol/domain operations. The IDE pins this Rust crate by Git revision, retaining IPC authorization and lifecycle coordination. This library is statically linked; disabling the workbench removes access and UI rather than unloading native machine code. Filesystem operations use canonical confinement and optimistic write checks. Synthetic tests do not invoke real inference.

The process permission authorizes brokered native operations under the user account. Consent is required before activation; the workbench grant alone does not authorize process execution.
