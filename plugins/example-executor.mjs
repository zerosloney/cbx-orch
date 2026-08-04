// Executor plugin API cbx.executor/v1: export manifest and run(request).
export const manifest = {
  apiVersion: "cbx.executor/v1",
  name: "example-executor",
  version: "1.0.0",
  capabilities: ["execute"],
};
export async function run(request) {
  console.log(`Example executor received: ${request.prompt.slice(0, 80)}`);
  return { code: 0, output: "example executor completed", timedOut: false };
}
