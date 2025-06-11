// generic assert that type-narrows
export function assert(condition: any, msg?: string): asserts condition {
  if (!condition) {
    const err = new Error(msg || 'Assertion failed (no message given)');
    err.name = 'AssertionError';
    throw err;
  }
}