# Self-implemented download bridge instead of the Skills CLI

The Skills CLI (`npx skills`) is the ecosystem's official package manager, but it supports 70+ agents without dsh among them, and its own install registry layout does not match what dsh expects in the Skills Directory. We therefore implement the install/update path ourselves: resolve the Source's default-branch commit, download the GitHub codeload tarball, extract only the Skill's subdirectory, and write it into the Skills Directory.

Considered and rejected: shelling out to `npx skills add` into a neutral directory and copying the result — it adds an external runtime dependency on the user's environment, exposes us to CLI behaviour drift, and still leaves update detection for us to reimplement.
