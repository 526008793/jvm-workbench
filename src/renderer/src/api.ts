import type { ApiResult } from '../../shared/models';

export async function unwrap<T>(request: Promise<ApiResult<T>>): Promise<T> {
  const result = await request;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败';
}
