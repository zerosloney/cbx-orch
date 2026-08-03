// Executor plugin API: export async function run(request) -> { code, output, timedOut }.
// The request contains directory, workdir, prompt, timeoutMs, maxTurns and permissionMode.
export async function run(request) {
  console.log(`Example executor received: ${request.prompt.slice(0, 80)}`);
  return { code: 0, output: "example executor completed", timedOut: false };
}
