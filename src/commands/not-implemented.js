/**
 * Shared stub for commands that are planned but not built yet.
 * Exit code 2 so scripts can tell "not implemented" apart from a failure.
 */
export function notImplemented(name, plan, { err }) {
  err(`gentifi ${name} is not implemented yet.\n\nPlanned:\n${plan.map((p) => `  - ${p}`).join('\n')}`);
  err('\nFollow progress or help build it: https://github.com/SelfBankt/gentifi-toolkit');
  return 2;
}
