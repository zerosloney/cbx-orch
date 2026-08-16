import path from "node:path";
import { cleanupRecordedWorktree, cleanupStageWorktree, prepareStageWorktree } from "./git-ops.js";
import { jobDir } from "./state.js";

export { prepareStageWorktree, cleanupStageWorktree };

export async function cleanupWorktree(workspaceInput: string, jobId: string): Promise<boolean> {
  const workspace = path.resolve(workspaceInput);
  const directory = jobDir(workspace, jobId);
  return cleanupRecordedWorktree(workspace, directory);
}
