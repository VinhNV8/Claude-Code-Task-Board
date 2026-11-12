// Cấu hình model 3 tầng (PLAN P5, D1/D2/D3). Hàm thuần, không đụng DB.
import { HttpError } from './httpError.ts'
import { modelAliasLabel, suggestModel, type PickInput, type Suggestion } from './modelPicker.ts'
import type { ModelSource, Run, RunKind } from './types.ts'

/** D1: alias truyền thẳng vào `--model`, CLI tự chọn bản mới nhất. */
export const MODEL_ALIASES = ['haiku', 'sonnet', 'opus'] as const
export type ModelAlias = (typeof MODEL_ALIASES)[number]

const MODEL_ID_RE = /^claude-[a-z0-9-]+$/

/** D1: alias hoặc ID đầy đủ dạng `claude-…`. */
export function isValidModel(v: string): boolean {
  return (MODEL_ALIASES as readonly string[]).includes(v) || MODEL_ID_RE.test(v)
}

/** D2: giá trị cấu hình nghĩa là "để bộ chọn model quyết định" (P5-04). */
export const AUTO_MODEL = 'auto'

/** Chuẩn hoá giá trị model từ API: trim + lowercase; '' nếu rỗng; sai định dạng thì ném HttpError 400. */
export function normalizeModel(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new HttpError(400, `Model không hợp lệ: ${String(v)}`)
  const m = v.trim().toLowerCase()
  if (!m) return ''
  if (m === AUTO_MODEL) return m
  if (m.length > 100 || !isValidModel(m))
    throw new HttpError(400, `Model không hợp lệ: ${v.trim().slice(0, 100)}. Dùng auto, haiku, sonnet, opus hoặc ID dạng claude-…`)
  return m
}

export type ModelLevel = 'task' | 'project' | 'settings' | 'none'

/** D2: giá trị không rỗng đầu tiên Task → Project → Settings. */
export function resolveModelSetting(
  task: { model?: string },
  project: { defaultModel?: string },
  settings: { defaultModel?: string },
): { value: string | undefined; level: ModelLevel } {
  const pick = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined)
  const t = pick(task.model)
  if (t) return { value: t, level: 'task' }
  const p = pick(project.defaultModel)
  if (p) return { value: p, level: 'project' }
  const s = pick(settings.defaultModel)
  if (s) return { value: s, level: 'settings' }
  return { value: undefined, level: 'none' }
}

const LEVEL_REASON: Record<ModelLevel, string> = {
  task: 'Chọn ở task',
  project: 'Mặc định của project',
  settings: 'Mặc định hệ thống',
  none: 'Mặc định của Claude CLI',
}

/** Nguồn và lý do ghi vào run (D8): chọn ở task = manual, còn lại = default. */
export function modelChoiceFor(level: ModelLevel): { modelSource: ModelSource; modelReason: string } {
  return { modelSource: level === 'task' ? 'manual' : 'default', modelReason: LEVEL_REASON[level] }
}

const KEPT_SUFFIX = ' (giữ từ lần chạy trước)'

export interface RunModelChoice {
  /** Giá trị truyền vào `--model`; undefined = không truyền. */
  requestedModel: string | undefined
  modelSource: ModelSource
  modelReason: string
  /** Chỉ có khi cấu hình hiệu lực là 'auto' và run là initial/retry. */
  suggestion?: Suggestion
}

/** Dòng log hệ thống khi bộ chọn tự chọn model. */
export const autoModelNote = (s: Suggestion) => `Tự chọn model: ${modelAliasLabel(s.model)} — ${s.reasons.join('; ')}`

/**
 * Model của một run (D3: chọn lúc run bắt đầu).
 * - 'initial' / 'retry': resolve 3 tầng (D2); giá trị 'auto' → bộ chọn model Lớp 1 (D4).
 * - 'resume' / 'continue': dùng lại `requestedModel` của run trước để giữ prompt cache, kể cả khi cấu hình đã đổi.
 */
export function chooseRunModel(
  kind: RunKind,
  prevRun: Pick<Run, 'requestedModel' | 'modelSource' | 'modelReason'> | undefined,
  task: { model?: string } & Partial<PickInput>,
  project: { defaultModel?: string },
  settings: { defaultModel?: string },
  /** P5-07 (D5): Lớp 2 điều chỉnh gợi ý của Lớp 1 theo lịch sử project. */
  adjust: SuggestionAdjuster = (s) => s,
): RunModelChoice {
  if ((kind === 'resume' || kind === 'continue') && prevRun) {
    const base = prevRun.modelReason?.replace(KEPT_SUFFIX, '')
    return {
      requestedModel: prevRun.requestedModel || undefined,
      modelSource: prevRun.modelSource ?? 'default',
      modelReason: base ? `${base}${KEPT_SUFFIX}` : 'Giữ model của lần chạy trước',
    }
  }
  const { value, level } = resolveModelSetting(task, project, settings)
  if (value?.toLowerCase() === AUTO_MODEL) {
    const suggestion = adjust(suggestModel(pickInputOf(task)))
    return { requestedModel: suggestion.model, modelSource: 'auto', modelReason: suggestion.reasons.join('; '), suggestion }
  }
  return { requestedModel: value, ...modelChoiceFor(level) }
}

function pickInputOf(t: Partial<PickInput>): PickInput {
  return { title: t.title ?? '', prompt: t.prompt ?? '', tags: t.tags ?? [], permissionMode: t.permissionMode ?? 'acceptEdits' }
}

/**
 * API `/api/model-suggest`: giá trị hiệu lực (task chưa có model nên chỉ xét Project → Settings)
 * và gợi ý khi giá trị đó là 'auto'.
 */
export function modelSuggestFor(
  input: Partial<PickInput>,
  project: { defaultModel?: string },
  settings: { defaultModel?: string },
  adjust: SuggestionAdjuster = (s) => s,
): { effective: { value: string | undefined; level: ModelLevel }; suggestion?: Suggestion } {
  const effective = resolveModelSetting({}, project, settings)
  if (effective.value?.toLowerCase() !== AUTO_MODEL) return { effective }
  return { effective, suggestion: adjust(suggestModel(pickInputOf(input))) }
}

export type SuggestionAdjuster = (s: Suggestion) => Suggestion

/** Opus hay quá tải: tự lùi về Sonnet (`--fallback-model`). */
export const fallbackModelFor = (model: string | undefined) => (model && model.includes('opus') ? 'sonnet' : undefined)
