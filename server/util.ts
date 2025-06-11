// generic assert
// TODO: replace 'better-assert' in the codebase with this
export function assert(condition: any, msg?: string): asserts condition {
  if (!condition) {
    throw new Error(msg || 'Assertion failed');
  }
}