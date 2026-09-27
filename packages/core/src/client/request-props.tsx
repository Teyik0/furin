import { createElement, type ElementType, type ReactNode } from "react";
import { jsx } from "react/jsx-runtime";

const fieldPromises = new WeakMap<Promise<object>, Map<string, Promise<unknown>>>();
const reservedKeys = new Set(["children", "key", "ref", "then", "catch", "finally", "toJSON"]);

export function createRouteElement(
  component: ElementType,
  data: Record<string, unknown>,
  children: ReactNode | undefined
): ReactNode {
  const { requestData, ...publicProps } = data;
  const props = children === undefined ? publicProps : { ...publicProps, children };
  if (
    requestData === null ||
    typeof requestData !== "object" ||
    typeof (requestData as Promise<object>).then !== "function"
  ) {
    return createElement(component, props);
  }

  const source = requestData as Promise<Record<string, unknown>>;
  let fields = fieldPromises.get(source);
  if (fields === undefined) {
    fields = new Map();
    fieldPromises.set(source, fields);
  }
  const privateProps = new Proxy(props, {
    get(target, key: string | symbol) {
      if (typeof key !== "string" || reservedKeys.has(key) || Object.hasOwn(target, key)) {
        return Reflect.get(target, key);
      }
      let promise = fields.get(key);
      if (promise === undefined) {
        promise = source.then((resolved) => resolved[key]);
        fields.set(key, promise);
      }
      return promise;
    },
  });
  return jsx(component, privateProps);
}
