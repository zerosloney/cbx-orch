import { APP_VERSION } from "./version.js";

// OpenAPI 3.1 文档：ui.ts 路由的机器可读说明书。
// 端点增删改时同步更新此文件；tests/openapi.test.ts 会校验文档与路由表一致。

interface Schema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
}

const errorResponse = {
  description: "错误",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

const unauthorizedResponse = {
  description: "未认证（配置 token 时需要 Bearer header 或 cbx_token cookie）",
  content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
};

const jobSummary: Schema = {
  type: "object",
  properties: {
    jobId: { type: "string" },
    status: { type: "string" },
    phase: { type: "string" },
    attempt: { type: "integer" },
    reviewVerdict: { type: ["string", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
};

const agentProbe: Schema = {
  type: "object",
  properties: {
    name: { type: "string" },
    label: { type: "string" },
    source: { type: "string", enum: ["builtin", "workspace", "user"] },
    aliases: { type: "array", items: { type: "string" } },
    available: { type: "boolean" },
    command: { type: ["array", "null"], items: { type: "string" } },
    error: { type: "string" },
  },
};

const securityOptional = [{ bearerAuth: [] }, { cookieAuth: [] }, {}];

function jsonResponse(description: string, schema: unknown): Record<string, unknown> {
  return { description, content: { "application/json": { schema } } };
}

function parameter(
  name: string,
  where: "query" | "path",
  description: string,
  schema: unknown = { type: "string" },
  required = false,
): Record<string, unknown> {
  return { name, in: where, description, required, schema };
}

export function buildOpenApiDocument(host: string, port: number): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "CBX Orchestrator API",
      version: APP_VERSION,
      description:
        "cbx 任务编排器的本地 REST API。server 仅绑定回环地址（127.0.0.1）；配置 token 后写操作需要 Bearer 凭证。POST 携带 body 时 content-type 必须是 application/json。",
    },
    servers: [{ url: `http://${host}:${port}` }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "`cbx ui --token <token>` 启动后以 Authorization: Bearer <token> 携带。",
        },
        cookieAuth: {
          type: "apiKey",
          in: "cookie",
          name: "cbx_token",
          description: "访问首页时经 HttpOnly cookie 自动下发，浏览器请求自动携带。",
        },
      },
      schemas: {
        Error: { type: "object", properties: { error: { type: "string" } }, required: ["error"] },
        Job: jobSummary,
        JobList: { type: "array", items: { $ref: "#/components/schemas/Job" } },
        AgentProbe: agentProbe,
        CreateJobRequest: {
          type: "object",
          required: ["task"],
          properties: {
            task: { type: "string", description: "任务描述（非空）" },
            profile: {
              type: "string",
              enum: ["fast", "verified", "governed", "untrusted"],
            },
            routing_strategy: {
              type: "string",
              enum: ["best", "cheapest", "fastest"],
              description: "auto 路由策略（best=战绩决胜缺省；cheapest/fastest=能力同层按均值 token/任务墙钟选优）",
            },
            test_command: { type: "string" },
            review: { type: "boolean" },
            isolated: { type: "boolean" },
            timeout_ms: { type: "integer" },
            max_retries: { type: "integer" },
            max_turns: { type: "integer" },
            permission_mode: { type: "string" },
            approval_before_run: { type: "boolean" },
            approval_before_complete: { type: "boolean" },
            dependency_guard: { type: "boolean" },
            keep_worktree: { type: "boolean" },
            executor: { type: "string", description: "内置名、agent spec 名或 ESM 插件路径" },
            review_executor: { type: "string" },
            auto_branch: { type: "boolean" },
            auto_commit: { type: "boolean" },
            commit_message: { type: "string" },
            context_snapshot: { type: "string" },
            allow_unsafe_permissions: { type: "boolean" },
            priority: { type: "integer" },
          },
        },
        CreateJobResponse: {
          type: "object",
          properties: { job_id: { type: "string" }, status: { type: "string" } },
          required: ["job_id", "status"],
        },
      },
    },
    security: securityOptional,
    paths: {
      "/healthz": {
        get: {
          summary: "健康检查（无需鉴权）",
          security: [],
          responses: { "200": jsonResponse("服务健康状态", { type: "object" }) },
        },
      },
      "/api/metrics": {
        get: {
          summary: "指标与队列统计",
          responses: {
            "200": jsonResponse("health() 结果（队列/任务计数等）", { type: "object" }),
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/workspaces": {
        get: {
          summary: "已挂载的 workspace 列表",
          responses: {
            "200": jsonResponse(
              "{ workspaces: [...], default: string }",
              { type: "object" },
            ),
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/agents": {
        get: {
          summary: "agent 注册表快照（含二进制可用性探测）",
          description:
            "返回内置适配器 + .cbx/agents/*.json 与 ~/.cbx/agents/*.json spec 注册的 agent，附 PATH 探测结果。",
          responses: {
            "200": jsonResponse(
              "{ agents: AgentProbe[], errors: string[] }",
              {
                type: "object",
                properties: {
                  agents: { type: "array", items: { $ref: "#/components/schemas/AgentProbe" } },
                  errors: { type: "array", items: { type: "string" } },
                },
              },
            ),
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/queue": {
        get: {
          summary: "队列状态（暂停/并发上限/条目）",
          responses: {
            "200": jsonResponse("listQueue() 结果", { type: "object" }),
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/queue/pause": {
        post: {
          summary: "暂停队列",
          responses: {
            "200": jsonResponse("更新后的队列状态", { type: "object" }),
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/queue/resume": {
        post: {
          summary: "恢复队列",
          responses: {
            "200": jsonResponse("更新后的队列状态", { type: "object" }),
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/jobs": {
        get: {
          summary: "任务列表",
          parameters: [
            parameter(
              "limit",
              "query",
              "只返回最近 N 条（updated_at 倒序，1-10000）",
              { type: "integer", minimum: 1, maximum: 10000 },
            ),
            parameter(
              "workspace",
              "query",
              "多 workspace 时指定目标（URL 编码的绝对路径）",
            ),
          ],
          responses: {
            "200": jsonResponse(
              "任务数组",
              { type: "array", items: { $ref: "#/components/schemas/Job" } },
            ),
            "400": errorResponse,
            "401": unauthorizedResponse,
          },
        },
        post: {
          summary: "创建任务并入队",
          requestBody: {
            required: true,
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/CreateJobRequest" } },
            },
          },
          responses: {
            "201": jsonResponse(
              "已创建并入队",
              { $ref: "#/components/schemas/CreateJobResponse" },
            ),
            "400": errorResponse,
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/jobs/{jobId}": {
        get: {
          summary: "任务详情（完整 JobState）",
          parameters: [parameter("jobId", "path", "任务 ID", { type: "string" }, true)],
          responses: {
            "200": jsonResponse("任务状态", { type: "object" }),
            "404": errorResponse,
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/jobs/{jobId}/timeline": {
        get: {
          summary: "事件推导的阶段时间线",
          parameters: [parameter("jobId", "path", "任务 ID", { type: "string" }, true)],
          responses: {
            "200": jsonResponse("阶段时间线", { type: "object" }),
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/jobs/{jobId}/executor": {
        get: {
          summary: "执行器实时状态（进程/心跳）",
          parameters: [parameter("jobId", "path", "任务 ID", { type: "string" }, true)],
          responses: {
            "200": jsonResponse("执行器状态", { type: "object" }),
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/jobs/{jobId}/agent.log": {
        get: {
          summary: "agent 原始日志（增量）",
          parameters: [
            parameter("jobId", "path", "任务 ID", { type: "string" }, true),
            parameter("since", "query", "字节偏移，返回增量内容", { type: "integer" }),
          ],
          responses: {
            "200": { description: "JSON 包装的增量日志" },
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/jobs/{jobId}/events": {
        get: {
          summary: "任务事件流（ndjson，增量）",
          parameters: [
            parameter("jobId", "path", "任务 ID", { type: "string" }, true),
            parameter("since", "query", "起始 seq", { type: "integer" }),
          ],
          responses: {
            "200": { description: "事件数组" },
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/jobs/{jobId}/artifacts": {
        get: {
          summary: "产物列表",
          parameters: [parameter("jobId", "path", "任务 ID", { type: "string" }, true)],
          responses: {
            "200": jsonResponse("产物条目数组", { type: "array", items: { type: "object" } }),
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/jobs/{jobId}/artifact/{name}": {
        get: {
          summary: "读取单个产物（diff/review.md 等）",
          parameters: [
            parameter("jobId", "path", "任务 ID", { type: "string" }, true),
            parameter("name", "path", "产物名", { type: "string" }, true),
          ],
          responses: {
            "200": { description: "产物原文（text）" },
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/jobs/{jobId}/approve": {
        post: {
          summary: "批准 before_run 审批门并重新入队",
          parameters: [parameter("jobId", "path", "任务 ID", { type: "string" }, true)],
          responses: {
            "200": jsonResponse("更新后的任务状态", { type: "object" }),
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/jobs/{jobId}/cancel": {
        post: {
          summary: "取消任务",
          parameters: [parameter("jobId", "path", "任务 ID", { type: "string" }, true)],
          responses: {
            "200": jsonResponse("更新后的任务状态", { type: "object" }),
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/jobs/{jobId}/retry": {
        post: {
          summary: "重试失败任务",
          parameters: [parameter("jobId", "path", "任务 ID", { type: "string" }, true)],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { priority: { type: "integer" } },
                },
              },
            },
          },
          responses: {
            "200": jsonResponse("更新后的任务状态", { type: "object" }),
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/jobs/{jobId}/continue": {
        post: {
          summary: "needs_fix/review_failed 后带反馈继续",
          parameters: [parameter("jobId", "path", "任务 ID", { type: "string" }, true)],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    message: { type: "string", description: "返工反馈" },
                    priority: { type: "integer" },
                    context_snapshot: { type: "string" },
                    refresh_baseline: { type: "boolean" },
                    extra_rounds: { type: "integer", minimum: 1, maximum: 100 },
                  },
                },
              },
            },
          },
          responses: {
            "200": jsonResponse("{ jobId, status: 'queued' }", { type: "object" }),
            "400": errorResponse,
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/jobs/{jobId}/forget": {
        post: {
          summary: "遗忘任务（保留 worktree）",
          parameters: [parameter("jobId", "path", "任务 ID", { type: "string" }, true)],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { reason: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "200": jsonResponse("删除结果", { type: "object" }),
            "401": unauthorizedResponse,
          },
        },
      },
      "/api/jobs/{jobId}/purge": {
        post: {
          summary: "彻底删除任务（含 worktree）",
          parameters: [parameter("jobId", "path", "任务 ID", { type: "string" }, true)],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { reason: { type: "string" } },
                },
              },
            },
          },
          responses: {
            "200": jsonResponse("删除结果", { type: "object" }),
            "401": unauthorizedResponse,
          },
        },
      },
      "/events": {
        get: {
          summary: "全 workspace SSE 事件流",
          description:
            "text/event-stream。支持 Last-Event-ID（复合游标 <wsIndex>:<seq>）回放；EventSource 无法设 header，允许 ?token= 查询参数。",
          responses: {
            "200": {
              description: "SSE 事件流",
              content: { "text/event-stream": { schema: { type: "string" } } },
            },
            "401": unauthorizedResponse,
          },
        },
      },
    },
  };
}
