# Confirmation enforced on the host, not just in the UI

Overwrite installs, updates, and uninstalls require explicit user Confirmation (exam requirement). The WebUI shows a modal, but the host-side RPCs for these operations also refuse to run without an explicit confirmation: the client first calls without one, receives a confirmation-required response describing the impact (skill, Source, target path, action), and only re-calls with confirmation after the user approves.

This two-phase protocol keeps a future or buggy client from silently mutating the Skills Directory. Host-side Path Safety checks exist for the same reason: the UI is a convenience, not a security boundary.
