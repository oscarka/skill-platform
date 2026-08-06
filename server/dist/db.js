"use strict";
/**
 * db.ts — 智能路由层
 *
 * - 本地开发 (DATABASE_URL 未设置): 使用 SQLite (better-sqlite3)
 * - 生产环境 (DATABASE_URL 已设置): 使用 PostgreSQL (Supabase via pg)
 *
 * 对外导出的接口完全一致，调用方无需感知底层差异。
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAsync = runAsync;
exports.getAsync = getAsync;
exports.allAsync = allAsync;
exports.run = run;
exports.get = get;
exports.all = all;
exports.initDb = initDb;
const USE_POSTGRES = !!process.env.DATABASE_URL;
if (USE_POSTGRES) {
    console.log('[DB] Mode: PostgreSQL (Supabase)');
}
else {
    console.log('[DB] Mode: SQLite (local dev)');
}
// ─── 导出统一接口 ─────────────────────────────────────────────────────────────
async function runAsync(sql, params = []) {
    if (USE_POSTGRES) {
        const pg = await Promise.resolve().then(() => __importStar(require('./db-postgres')));
        return pg.runAsync(sql, params);
    }
    else {
        const sq = await Promise.resolve().then(() => __importStar(require('./db-sqlite')));
        sq.run(sql, params);
    }
}
async function getAsync(sql, params = []) {
    if (USE_POSTGRES) {
        const pg = await Promise.resolve().then(() => __importStar(require('./db-postgres')));
        return pg.getAsync(sql, params);
    }
    else {
        const sq = await Promise.resolve().then(() => __importStar(require('./db-sqlite')));
        return sq.get(sql, params);
    }
}
async function allAsync(sql, params = []) {
    if (USE_POSTGRES) {
        const pg = await Promise.resolve().then(() => __importStar(require('./db-postgres')));
        return pg.allAsync(sql, params);
    }
    else {
        const sq = await Promise.resolve().then(() => __importStar(require('./db-sqlite')));
        return sq.all(sql, params);
    }
}
/** 同步兼容层（仅用于少数遗留同步调用） */
function run(sql, params = []) {
    runAsync(sql, params).catch(e => console.error('[DB] run error:', e.message));
}
function get(sql, params = []) {
    if (!USE_POSTGRES) {
        try {
            const sq = require('./db-sqlite');
            return (sq.get(sql, params));
        }
        catch {
            return undefined;
        }
    }
    console.warn('[DB] get() called synchronously in PostgreSQL mode — use getAsync() instead');
    return undefined;
}
function all(sql, params = []) {
    if (!USE_POSTGRES) {
        try {
            const sq = require('./db-sqlite');
            return (sq.all(sql, params));
        }
        catch {
            return [];
        }
    }
    console.warn('[DB] all() called synchronously in PostgreSQL mode — use allAsync() instead');
    return [];
}
async function initDb() {
    if (USE_POSTGRES) {
        const pg = await Promise.resolve().then(() => __importStar(require('./db-postgres')));
        return pg.initDb();
    }
    else {
        const sq = await Promise.resolve().then(() => __importStar(require('./db-sqlite')));
        sq.initDb();
    }
}
