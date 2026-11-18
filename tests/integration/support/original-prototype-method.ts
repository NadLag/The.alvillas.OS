/** Capture a prototype implementation before a test installs a spy. Calls can then supply their original receiver. */
export function originalPrototypeMethod<Prototype extends object, Key extends keyof Prototype>(
  prototype: Prototype,
  key: Key
): Prototype[Key] {
  const method: unknown = Object.getOwnPropertyDescriptor(prototype, key)?.value;
  if (typeof method !== "function") throw new TypeError("Missing prototype method " + String(key));
  return method as Prototype[Key];
}
