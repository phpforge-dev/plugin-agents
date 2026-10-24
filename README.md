# Agents plugin

Independent PHPForge workbench package, extracted from the MIT PHP IDE implementation. Requires IDE 0.2.13 and explicit project.read/workbench consent.

Owns feature UI, interaction workflows and rendering. The host currently brokers the declared operations in plugin.json. Feature-specific Rust backend extraction is tracked separately; this package does not claim an independently unloadable backend. No Node runtime is used in the IDE.

Build and validate: `npm ci --ignore-scripts`, `npm test`, `npm run build`. Prebuilt browser assets are committed. Disable removes owned UI, listeners and polling. Native process access remains governed by host permissions.
