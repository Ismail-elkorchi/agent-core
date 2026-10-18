/** Trusted guest-side adapter. Source is passed as data to the guest AsyncFunction constructor. */
export const GUEST_ADAPTER = String.raw`
(async function (hostCall, manifest, source, inputLimit, outputLimit) {
  "use strict";
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const ownKeys = Reflect.ownKeys;
  const getDescriptor = Object.getOwnPropertyDescriptor;
  const getPrototype = Object.getPrototypeOf;
  const define = Object.defineProperty;
  const create = Object.create;
  const freeze = Object.freeze;
  const setPrototype = Object.setPrototypeOf;
  const StringType = String;
  const isArray = Array.isArray;
  const finite = Number.isFinite;
  const objectPrototype = Object.prototype;
  const arrayPrototype = Array.prototype;
  const ErrorType = Error;
  const SetType = Set;
  const hasOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  const setHas = Function.prototype.call.bind(Set.prototype.has);
  const setAdd = Function.prototype.call.bind(Set.prototype.add);
  const setDelete = Function.prototype.call.bind(Set.prototype.delete);
  function encode(value, limit) {
    let entries = 0;
    const ancestors = new SetType();
    function capture(item, depth) {
      if (item === null || typeof item === "boolean") return item;
      if (typeof item === "string") {
        if (item.length > limit) throw new ErrorType("Program JSON string limit exceeded.");
        return item;
      }
      if (typeof item === "number" && finite(item)) return item;
      if (typeof item !== "object" || depth > 32) throw new ErrorType("Program values must be bounded JSON.");
      if (setHas(ancestors, item)) throw new ErrorType("Program JSON contains a cycle.");
      setAdd(ancestors, item);
      const array = isArray(item);
      const prototype = getPrototype(item);
      if (prototype !== null && prototype !== (array ? arrayPrototype : objectPrototype))
        throw new ErrorType("Program JSON requires plain objects and arrays.");
      const keys = ownKeys(item);
      entries += keys.length;
      if (entries > 20000) throw new ErrorType("Program JSON collection limit exceeded.");
      const result = create(null);
      let length = 0;
      if (array) {
        const descriptor = getDescriptor(item, "length");
        length = descriptor.value;
        if (keys.length !== length + 1) throw new ErrorType("Program JSON arrays must be dense.");
      }
      for (let index = 0; index < keys.length; index++) {
        const key = keys[index];
        if (array && key === "length") continue;
        if (typeof key !== "string" || key.length > limit) throw new ErrorType("Program JSON keys must be bounded strings.");
        const descriptor = getDescriptor(item, key);
        if (!descriptor || !descriptor.enumerable || !hasOwn(descriptor, "value"))
          throw new ErrorType("Program JSON properties must be enumerable data properties.");
        define(result, key, { value: capture(descriptor.value, depth + 1), enumerable: true });
      }
      setDelete(ancestors, item);
      if (!array) return result;
      // A replacer-free JSON stringifier must not invoke an inherited toJSON.
      const output = [];
      setPrototype(output, null);
      for (let index = 0; index < length; index++) {
        const descriptor = getDescriptor(result, StringType(index));
        if (!descriptor) throw new ErrorType("Program JSON arrays must have only indexed properties.");
        define(output, StringType(index), { value: descriptor.value, enumerable: true, configurable: true, writable: true });
      }
      return output;
    }
    const encoded = stringify(capture(value, 0));
    if (encoded.length > limit) throw new ErrorType("Program JSON byte limit exceeded.");
    return encoded;
  }
  function deepFreeze(value) {
    if (value && typeof value === "object") {
      const keys = ownKeys(value);
      for (let index = 0; index < keys.length; index++) deepFreeze(value[keys[index]]);
      freeze(value);
    }
    return value;
  }
  // Crossing the serialized VM boundary creates new objects with no host freeze
  // state. Capture immutable guest-owned metadata before untrusted code begins.
  const tools = deepFreeze(parse(manifest));
  const call = async function (name, input) {
    if (typeof name !== "string" || name.length > 128)
      throw new ErrorType("Program tool name must be a bounded string.");
    if (!input || typeof input !== "object" || isArray(input))
      throw new ErrorType("Program call input must be a JSON object.");
    const receipt = await hostCall(name, encode(input, inputLimit));
    return parse(receipt);
  };
  const run = new AsyncFunction("call", "tools", '"use strict";\n' + source);
  const value = await run(call, tools);
  return encode(value === undefined ? null : value, outputLimit);
})
`;
