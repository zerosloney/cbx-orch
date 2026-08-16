/** 统一错误类型：控制流按错误码判定，消除按消息字符串匹配的耦合（消息文案保留给用户与测试断言）。 */

export type CbxErrorCode =
  | "E_INVALID_JOB_ID"
  | "E_ARTIFACT_FORBIDDEN"
  | "E_INVALID_CONTEXT"
  | "E_LOCK_BUSY"
  | "E_QUEUE_BUSY"
  | "E_NOT_FOUND"
  /** 入参/配置/组合策略校验失败（测试命令被拒、adaptive 组合非法、任务参数越界等）。 */
  | "E_VALIDATION"
  /** 当前状态下不允许该操作（重复审批、运行中 retry、任务已存在等）。 */
  | "E_STATE_CONFLICT";

export class CbxError extends Error {
  readonly code: CbxErrorCode;
  constructor(code: CbxErrorCode, message: string) {
    super(message);
    this.name = "CbxError";
    this.code = code;
  }
}

export function isCbxError(error: unknown, code?: CbxErrorCode): error is CbxError {
  return error instanceof CbxError && (code === undefined || error.code === code);
}

/**
 * 错误 → HTTP 状态码集中映射。此前 ui.ts 内联 errno + 逐个 isCbxError 的 if-else 链，
 * 新增错误码的调用点容易漏映射而落到 500；HTTP 层（Web UI 等）统一改走本函数。
 * errno（文件系统类）优先于 CbxError code 判定。
 */
export function httpStatusForError(error: unknown): number {
  const errno = (error as NodeJS.ErrnoException)?.code;
  if (errno === "ENOENT") return 404;
  if (errno === "EBIG") return 413;
  if (error instanceof CbxError) {
    switch (error.code) {
      case "E_NOT_FOUND":
        return 404;
      case "E_ARTIFACT_FORBIDDEN":
        return 403;
      case "E_INVALID_JOB_ID":
      case "E_INVALID_CONTEXT":
      case "E_VALIDATION":
        return 400;
      case "E_LOCK_BUSY":
      case "E_QUEUE_BUSY":
      case "E_STATE_CONFLICT":
        return 409;
    }
  }
  return 500;
}
