import type { StreamLogEvent } from "./types.js";

export interface LogFilterContext {
  jobId: string;
  executor: string;
  stageName?: string;
}

export interface LogEventFilter {
  readonly name: string;
  processLine(line: string, ctx: LogFilterContext): StreamLogEvent[];
  flush?(ctx: LogFilterContext): StreamLogEvent[];
}

function now(): string {
  return new Date().toISOString();
}

/** CodeBuddy stream-json 格式解析器 */
export class CodeBuddyStreamFilter implements LogEventFilter {
  readonly name = "codebuddy";

  processLine(line: string, ctx: LogFilterContext): StreamLogEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    if (!trimmed.startsWith("{")) {
      return [
        {
          jobId: ctx.jobId,
          stageName: ctx.stageName,
          executor: ctx.executor,
          timestamp: now(),
          kind: "text",
          content: trimmed,
        },
      ];
    }

    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const events: StreamLogEvent[] = [];
      const timestamp = now();

      const type = String(obj.type ?? "");

      if (type === "content_block_delta") {
        const delta = (obj.delta ?? {}) as Record<string, unknown>;
        const deltaType = String(delta.type ?? "");
        if (deltaType === "thinking_delta" && delta.thinking) {
          events.push({
            jobId: ctx.jobId,
            stageName: ctx.stageName,
            executor: ctx.executor,
            timestamp,
            kind: "thought",
            content: String(delta.thinking),
          });
        } else if (deltaType === "text_delta" && delta.text) {
          events.push({
            jobId: ctx.jobId,
            stageName: ctx.stageName,
            executor: ctx.executor,
            timestamp,
            kind: "text",
            content: String(delta.text),
          });
        }
      } else if (
        type === "tool_use" ||
        (type === "content_block_start" &&
          (obj.content_block as Record<string, unknown> | undefined)?.type === "tool_use")
      ) {
        const block =
          type === "tool_use"
            ? obj
            : ((obj.content_block ?? {}) as Record<string, unknown>);
        const toolName = String(block.name ?? "unknown_tool");
        const toolArgs = (block.input ?? {}) as Record<string, unknown>;
        events.push({
          jobId: ctx.jobId,
          stageName: ctx.stageName,
          executor: ctx.executor,
          timestamp,
          kind: "tool_use",
          content: `Tool Call: ${toolName}`,
          meta: { toolName, toolArgs },
        });
      } else if (type === "turn_start" || type === "user_message") {
        events.push({
          jobId: ctx.jobId,
          stageName: ctx.stageName,
          executor: ctx.executor,
          timestamp,
          kind: "turn_start",
          content: "Turn started",
        });
      } else if (type === "turn_end" || type === "assistant_message") {
        events.push({
          jobId: ctx.jobId,
          stageName: ctx.stageName,
          executor: ctx.executor,
          timestamp,
          kind: "turn_end",
          content: "Turn ended",
        });
      } else if (type === "error") {
        events.push({
          jobId: ctx.jobId,
          stageName: ctx.stageName,
          executor: ctx.executor,
          timestamp,
          kind: "error",
          content: String(obj.message ?? obj.error ?? "CodeBuddy Error"),
        });
      }

      return events;
    } catch {
      return [
        {
          jobId: ctx.jobId,
          stageName: ctx.stageName,
          executor: ctx.executor,
          timestamp: now(),
          kind: "text",
          content: trimmed,
        },
      ];
    }
  }
}

/** Qwen Code stream-json 格式解析器 */
export class QwenStreamFilter implements LogEventFilter {
  readonly name = "qwen";

  processLine(line: string, ctx: LogFilterContext): StreamLogEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    if (!trimmed.startsWith("{")) {
      return [
        {
          jobId: ctx.jobId,
          stageName: ctx.stageName,
          executor: ctx.executor,
          timestamp: now(),
          kind: "text",
          content: trimmed,
        },
      ];
    }

    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const events: StreamLogEvent[] = [];
      const timestamp = now();

      if (obj.error) {
        const errObj = obj.error as Record<string, unknown>;
        events.push({
          jobId: ctx.jobId,
          stageName: ctx.stageName,
          executor: ctx.executor,
          timestamp,
          kind: "error",
          content: String(errObj.message ?? JSON.stringify(errObj)),
        });
        return events;
      }

      const choices = (obj.choices ?? []) as Array<Record<string, unknown>>;
      if (choices.length > 0) {
        const delta = (choices[0].delta ?? {}) as Record<string, unknown>;
        if (delta.reasoning_content) {
          events.push({
            jobId: ctx.jobId,
            stageName: ctx.stageName,
            executor: ctx.executor,
            timestamp,
            kind: "thought",
            content: String(delta.reasoning_content),
          });
        }
        if (delta.content) {
          events.push({
            jobId: ctx.jobId,
            stageName: ctx.stageName,
            executor: ctx.executor,
            timestamp,
            kind: "text",
            content: String(delta.content),
          });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
            const fn = (tc.function ?? {}) as Record<string, unknown>;
            const toolName = String(fn.name ?? "tool");
            let toolArgs: Record<string, unknown> = {};
            try {
              if (typeof fn.arguments === "string") {
                toolArgs = JSON.parse(fn.arguments) as Record<string, unknown>;
              } else if (typeof fn.arguments === "object" && fn.arguments) {
                toolArgs = fn.arguments as Record<string, unknown>;
              }
            } catch {
              toolArgs = { raw: fn.arguments };
            }
            events.push({
              jobId: ctx.jobId,
              stageName: ctx.stageName,
              executor: ctx.executor,
              timestamp,
              kind: "tool_use",
              content: `Tool Call: ${toolName}`,
              meta: { toolName, toolArgs },
            });
          }
        }
      }

      return events;
    } catch {
      return [
        {
          jobId: ctx.jobId,
          stageName: ctx.stageName,
          executor: ctx.executor,
          timestamp: now(),
          kind: "text",
          content: trimmed,
        },
      ];
    }
  }
}

/** 通用文本/正则启发式回落解析器 */
export class GenericTextStreamFilter implements LogEventFilter {
  readonly name = "generic";

  processLine(line: string, ctx: LogFilterContext): StreamLogEvent[] {
    const trimmed = line.trim();
    if (!trimmed) return [];

    const timestamp = now();

    if (
      /^(Thought|Thinking|Reasoning):/i.test(trimmed) ||
      /^\[(Thought|Reasoning)\]/i.test(trimmed)
    ) {
      return [
        {
          jobId: ctx.jobId,
          stageName: ctx.stageName,
          executor: ctx.executor,
          timestamp,
          kind: "thought",
          content:
            trimmed.replace(/^(Thought|Thinking|Reasoning):/i, "").trim() ||
            trimmed,
        },
      ];
    }

    if (
      /^\[Tool:?\s*(\w+)\]/i.test(trimmed) ||
      /^Executing tool:?\s*(\w+)/i.test(trimmed)
    ) {
      const match =
        trimmed.match(/^\[Tool:?\s*(\w+)\]/i) ||
        trimmed.match(/^Executing tool:?\s*(\w+)/i);
      const toolName = match ? match[1] : "unknown";
      return [
        {
          jobId: ctx.jobId,
          stageName: ctx.stageName,
          executor: ctx.executor,
          timestamp,
          kind: "tool_use",
          content: trimmed,
          meta: { toolName },
        },
      ];
    }

    if (
      /^(Error|FAILED|Exception):/i.test(trimmed) ||
      /\[ERROR\]/i.test(trimmed)
    ) {
      return [
        {
          jobId: ctx.jobId,
          stageName: ctx.stageName,
          executor: ctx.executor,
          timestamp,
          kind: "error",
          content: trimmed,
        },
      ];
    }

    return [
      {
        jobId: ctx.jobId,
        stageName: ctx.stageName,
        executor: ctx.executor,
        timestamp,
        kind: "text",
        content: trimmed,
      },
    ];
  }
}

/** 根据执行器名称构造对应的 LogEventFilter */
export function createLogEventFilter(executor: string): LogEventFilter {
  const normalized = executor.toLowerCase();
  if (normalized.includes("codebuddy") || normalized === "cbc") {
    return new CodeBuddyStreamFilter();
  }
  if (normalized.includes("qwen")) {
    return new QwenStreamFilter();
  }
  return new GenericTextStreamFilter();
}

/** 流式按行缓冲累加器：处理 chunk 并按行拆分推入 LogEventFilter */
export class LineStreamAccumulator {
  private buffer = "";
  private readonly filter: LogEventFilter;

  constructor(filter: LogEventFilter) {
    this.filter = filter;
  }

  feed(chunk: string | Buffer, ctx: LogFilterContext): StreamLogEvent[] {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";

    const events: StreamLogEvent[] = [];
    for (const line of lines) {
      if (line) {
        events.push(...this.filter.processLine(line, ctx));
      }
    }
    return events;
  }

  flush(ctx: LogFilterContext): StreamLogEvent[] {
    const events: StreamLogEvent[] = [];
    if (this.buffer.trim()) {
      events.push(...this.filter.processLine(this.buffer.trim(), ctx));
      this.buffer = "";
    }
    if (this.filter.flush) {
      events.push(...this.filter.flush(ctx));
    }
    return events;
  }
}
