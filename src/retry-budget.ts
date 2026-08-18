import { loadState, writeState } from "./state.js";

// 重试计数器持久化于 state.json：崩溃后被队列回收重入 runStage 时按持久值恢复，
// 避免每次 resume 都拿满预算绕过 maxRetries；显式 retry / 用户 resolve Human Gate 时由
// prepareContinuation、retryQueueJob 归零。每 stage 独立重试预算: stageRetries 是
// { [stageIndex]: { execution, fix } } 映射。崩溃后队列回收重入时读持久化值恢复。
export class RetryBudget {
  private executionUsed: number;
  private fixUsed: number;

  constructor(
    private readonly workspace: string,
    private readonly jobId: string,
    private readonly stageIndex: number,
    persisted: {
      stageRetries?:
        | Record<string, { execution: number; fix: number }>
        | undefined;
    },
    private readonly executionRetries: number,
    private readonly fixRetries: number,
  ) {
    const stageRetries = persisted.stageRetries ?? {};
    const entry = stageRetries[String(stageIndex)] ?? {
      execution: 0,
      fix: 0,
    };
    this.executionUsed = Math.max(
      0,
      Math.floor(Number(entry.execution) || 0),
    );
    this.fixUsed = Math.max(0, Math.floor(Number(entry.fix) || 0));
  }

  canRetryExecution(): boolean {
    return this.executionUsed < this.executionRetries;
  }

  canRetryFix(): boolean {
    return this.fixUsed < this.fixRetries;
  }

  get totalUsed(): number {
    return this.executionUsed + this.fixUsed;
  }

  async useExecutionRetry(): Promise<void> {
    this.executionUsed += 1;
    await this.persist();
  }

  async useFixRetry(): Promise<void> {
    this.fixUsed += 1;
    await this.persist();
  }

  private async persist(): Promise<void> {
    const current = await loadState(this.workspace, this.jobId);
    const currentRetries =
      (current.stageRetries as
        | Record<string, { execution: number; fix: number }>
        | undefined) ?? {};
    await writeState(this.workspace, this.jobId, {
      stageRetries: {
        ...currentRetries,
        [String(this.stageIndex)]: {
          execution: this.executionUsed,
          fix: this.fixUsed,
        },
      },
    });
  }
}
