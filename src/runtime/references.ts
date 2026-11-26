import { invalidData } from "./model.js"
import {
  Arr,
  Callable,
  getOwn,
  HostNamespace,
  isProgramAccessor,
  isRuntimeReference,
  Obj,
  Opaque,
  own,
  ownKeys,
  type Value,
} from "./objects.js"

/** Interpreter machinery that is never data, unlike a Date or Map, which cross some boundaries as copies. */
export const isOpaque = (value: Value): boolean => value instanceof Opaque || value instanceof HostNamespace

// Depth-first search over a value tree. `match` stops the walk; `skip` prunes a subtree without matching it. A
// structural check, so it never runs program code: program accessors are left out.
const find = (
  value: Value,
  match: (current: Value) => boolean,
  skip: (current: Value) => boolean,
  seen: Set<object>,
): boolean => {
  const pending: Array<Iterator<Value>> = [[value].values()]
  while (pending.length > 0) {
    const next = pending.at(-1)!.next()
    if (next.done) {
      pending.pop()
      continue
    }
    const current = next.value
    if (match(current)) return true
    if (!(current instanceof Obj) || skip(current) || seen.has(current)) continue
    seen.add(current)
    const keys = current.hasProgramAccessors
      ? ownKeys(current).filter((key) => !isProgramAccessor(own(current, key)!))
      : ownKeys(current)
    pending.push(keys.map((key) => getOwn(current, key)).values())
  }
  return false
}

const never = () => false

// A primitive holds no reference, and most arguments are primitives: no walk is set up for one.
const primitive = (value: Value): boolean => typeof value !== "object" || value === null

export const containsRuntimeReference = (value: Value): boolean =>
  !primitive(value) && find(value, isRuntimeReference, never, new Set())

export const containsOpaqueReference = (value: Value): boolean =>
  !primitive(value) && find(value, isOpaque, (current) => isRuntimeReference(current) && !isOpaque(current), new Set())

// Reject cycles before mutation so later boundary walks remain safe.
export const rejectCircularInsertion = (
  container: Obj,
  value: Value,
  label: string,
  seen = new Set<object>(),
): void => {
  if (hasCircularReference(container, value, seen)) throw circularValue(label)
}

export const hasCircularReference = (container: Obj, value: Value, seen?: Set<object>): boolean => {
  if (value === container) return true
  if (!(value instanceof Obj) || isRuntimeReference(value) || holdsNoObjects(value)) return false
  return find(value, (current) => current === container, isRuntimeReference, seen ?? new Set())
}

// A plain object or array whose own data slots and elements are all primitives reaches nothing, so it cannot close a
// cycle: the walk would find nothing, and skipping it saves its Set, iterators and key lists on every insertion.
const holdsNoObjects = (value: Obj): boolean => {
  if (value.constructor === Arr) {
    for (const item of (value as Arr).items) if (item instanceof Obj) return false
  } else if (value.constructor !== Obj) return false
  for (const slot of value.props.values()) if (!("value" in slot) || slot.value instanceof Obj) return false
  return true
}

export const circularValue = (label: string) => invalidData(`${label} contains a circular value.`)

export const describeValue = (value: Value): string => {
  if (value === null || value === undefined) return String(value)
  if (value instanceof Obj) return value.describe
  if (value instanceof HostNamespace) return "a namespace reference"
  return `a ${typeof value}`
}

export const typeofValue = (value: Value): string => {
  if (value instanceof Callable) return "function"
  if (value instanceof HostNamespace) return value.path.length > 0 ? "function" : "object"
  return typeof value
}
