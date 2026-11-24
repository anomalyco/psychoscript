// Members made lazily are there for a program that reaches their holders only through `constructor`.
const A = [].constructor, O = ({}).constructor
return [typeof A.fromAsync, await A.fromAsync([1, 2]), typeof O.getOwnPropertySymbols, typeof O.groupBy, typeof O.fromEntries,
  O.getOwnPropertyNames(A), O.getOwnPropertyNames(O), O.keys(O.getOwnPropertyDescriptors(O)).length]
