// Agent Harness：把「模型 → 工具 → 观察 → 再问模型」的循环交给 Vercel AI SDK，
// 我们只负责三件 SDK 不提供的事：工具执行前的守卫、每步的 trace、以及步数上限。
import { generateText, tool, jsonSchema, stepCountIs } from 'ai';
import { digestArgs } from './schema.mjs';
import { guard } from './tools.mjs';

// 步数上限：一次问答最多几轮工具调用。超出即终止，不静默继续——
// 无限循环会把用户的 token 烧光，而用户看不到发生了什么。
export const DEFAULT_MAX_STEPS = 6;

// 把注册表转成 AI SDK 认识的 tools 对象。
// 每个 execute 内部先跑 guard：拒绝时返回结构化错误而不是抛异常，
// 这样模型能读到原因并自我纠正；同时该步骤会被记为 rejected。
function toSdkTools(registry) {
  const tools = {};
  for (const [name, spec] of Object.entries(registry)) {
    tools[name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(spec.schema),
      execute: async (args) => {
        const verdict = await guard(name, args, registry);
        if (!verdict.ok) {
          // 用 _toolError 标记，便于 trace 与上层区分「工具拒绝」和「工具返回空结果」。
          return { _toolError: true, reason: verdict.reason };
        }
        return spec.run(verdict.value);
      },
    });
  }
  return tools;
}

// 根据一步的结果判定 outcome。工具拒绝与执行异常要分开记，
// 因为前者是安全边界生效（正常），后者是工具本身出了问题（需排查）。
function classifyStep(step) {
  const toolResults = step?.toolResults || [];
  const rejected = toolResults.find((result) => result?.output?._toolError);
  if (rejected) return { outcome: 'rejected', reason: rejected.output.reason };
  const failed = toolResults.find((result) => result?.isError || result?.error);
  if (failed) return { outcome: 'error', reason: '工具执行失败' };
  return { outcome: 'ok' };
}

/**
 * 跑一轮带工具的问答。
 *
 * @param {object} options
 * @param {object} options.model          由 provider.mjs 建立的语言模型
 * @param {string} options.system         系统提示词
 * @param {Array}  options.messages       对话消息
 * @param {object} options.registry       工具注册表（tools.mjs）
 * @param {number} [options.maxSteps]     工具循环步数上限
 * @param {number} [options.temperature]
 * @returns {{text: string, steps: number, toolCalls: number, usage: object, trace: Array}}
 */
export async function runAgent({ model, system, messages, registry = {}, maxSteps = DEFAULT_MAX_STEPS, temperature = 0.2 } = {}) {
  const trace = [];
  const startedAt = Date.now();

  const result = await generateText({
    model,
    system,
    messages,
    tools: toSdkTools(registry),
    stopWhen: stepCountIs(maxSteps),
    temperature,
    // 关掉 SDK 的重试：原先的实现不做重试，用户看到「立刻失败并给出中文原因」。
    // SDK 默认会重试 2 次，让 401/429 这类确定性错误白等十几秒，也会把真实原因包进 AI_RetryError。
    maxRetries: 0,
    onStepFinish(step) {
      const { outcome, reason } = classifyStep(step);
      for (const call of step.toolCalls || []) {
        trace.push({
          stepIndex: trace.length,
          toolName: call.toolName,
          argsDigest: digestArgs(call.input ?? call.args),
          durationMs: Date.now() - startedAt,
          outcome,
          ...(reason ? { reason } : {}),
        });
      }
    },
  });

  // 达到步数上限时 SDK 只是停下，不会报错；这里显式告知调用方，
  // 避免把「没答完」当成「答完了」呈现给用户。
  const hitStepLimit = result.steps?.length >= maxSteps && (result.steps.at(-1)?.toolCalls?.length || 0) > 0;

  return {
    text: result.text,
    steps: result.steps?.length || 0,
    toolCalls: result.toolCalls?.length || 0,
    usage: result.usage || {},
    trace,
    truncatedByStepLimit: hitStepLimit,
  };
}
