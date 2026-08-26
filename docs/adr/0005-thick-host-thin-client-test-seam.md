# Thick host service, thin WebUI client, tests at the service seam

All plugin logic — searching the Catalog, fetching descriptions, installing, updating, uninstalling, registry bookkeeping, path-safety enforcement — lives in one host-side service behind the plugin's RPC/HTTP endpoints. The React settings page is a thin shell that renders state and forwards user intent; it holds no business logic and carries no unit tests.

Consequences: automated tests (vitest) target the host service as the single highest seam, with an injected fetcher (mock Catalog/GitHub/codeload responses) and an injected Skills Directory root (a temp dir). This covers the exam's four required test areas — install, update, uninstall, path safety — deterministically and in milliseconds, at the cost of leaving UI rendering unverified by automation (it is exercised manually in the demo video instead).
