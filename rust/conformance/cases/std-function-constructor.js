// The Function constructor, however it is reached, is refused: there is no dynamic code.
const t = (f) => { try { return f() } catch (e) { return [e.name, e.message] } }
return [t(() => ({}).constructor.constructor("return 1")()), t(() => (() => 1).constructor("return 1")), t(() => Function("return 1")), t(() => new Function("return 1")), Function.prototype.constructor === Function, typeof Function]
