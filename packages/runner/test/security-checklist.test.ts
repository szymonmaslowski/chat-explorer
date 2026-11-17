import { describe, it } from 'vitest';

// The security acceptance checklist for coding forks, from the note "Coding forks: tools,
// workspace, brokered actions". Written before the coding profile, run after each build step, and
// kept as regression tests so later changes cannot quietly weaken the container.
describe('coding forks: security acceptance checklist', () => {
  it.todo('1. a LAN address and the cloud metadata address are unreachable from a container');
  it.todo('2. a host that is not allowed is unreachable, and DNS does not resolve names inside');
  it.todo('3. a job naming a host, credential pairing or image outside the ceilings is refused');
  it.todo('4. a job cannot pass extra docker run flags or unknown fields through');
  it.todo('5. a backend claiming coding is on, when the runner config says off, is refused');
  it.todo("6. a container cannot read the runner config or other forks' workspaces");
  it.todo('7. the dummy model token works only from its own container, and dies with it');
  it.todo("8. the runner's size check and host-side reads do not follow symlinks out");
  it.todo('9. a container cannot write the session folders of other forks');
  it.todo('10. hidden config entries stay out of the capabilities report and the proxy logs');
});
