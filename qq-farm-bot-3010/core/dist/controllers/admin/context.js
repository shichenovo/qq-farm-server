"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
function createAdminContext(dataProvider) {
    const tokens = new Set();
    return {
        tokens,
        app: null,
        server: null,
        io: null,
        provider: dataProvider,
    };
}
module.exports = { createAdminContext };
//# sourceMappingURL=context.js.map