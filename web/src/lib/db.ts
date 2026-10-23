/**
 * 只读库连接串（与后端 domain/services.db_kind 一致）：scheme 决定类型。
 * 页面只显示类型、主机与库名，从不显示口令。
 */

export type DbKind = "postgres" | "mysql" | "doris" | "clickhouse" | "mongo";

export const DB_SCHEMES: Record<string, DbKind> = {
  postgresql: "postgres", postgres: "postgres", mysql: "mysql", mariadb: "mysql",
  doris: "doris", clickhouse: "clickhouse", clickhouses: "clickhouse", mongodb: "mongo", "mongodb+srv": "mongo",
};

export const DB_LABEL: Record<DbKind, string> = {
  postgres: "PostgreSQL", mysql: "MySQL/MariaDB", doris: "Doris", clickhouse: "ClickHouse", mongo: "MongoDB",
};

/** 库名（与后端 DB_NAME_RE 一致）：小写字母开头，可含数字 _ -，最长 31 */
export const DB_NAME_RE = /^[a-z][a-z0-9_-]{0,30}$/;

export function dbScheme(url: string): string {
  const i = url.indexOf("://");
  return i > 0 ? url.slice(0, i).toLowerCase() : "";
}

export function dbKind(url: string): DbKind | null {
  return DB_SCHEMES[dbScheme(url)] ?? null;
}

/** 连接串里的主机与库名（不含账号口令）：clickhouse://u:p@1.2.3.4:8123/default → {host: "1.2.3.4:8123", database: "default"} */
export function dbWhere(url: string): { host: string; database: string } {
  const m = /^[a-z][\w+.-]*:\/\/(?:[^@/]*@)?([^/?#]*)(?:\/([^?#]*))?/i.exec(url.trim());
  return { host: m?.[1] ?? "", database: decodeURIComponent((m?.[2] ?? "").replace(/\/$/, "")) };
}

/** 一个库的错误：库名不合法 / 连接串类型不认识；override = 环境覆盖（空串表示本环境没有这个库） */
export function dbError(name: string, url: string, override = false): string | null {
  if (!DB_NAME_RE.test(name)) return `库名「${name || "（空）"}」不合法：小写字母开头，可含数字 _ -`;
  if (!url.trim()) return override ? null : `库 ${name} 的连接串不能为空`;
  if (!dbKind(url)) return `库 ${name} 的连接串类型不认识：${dbScheme(url) ? dbScheme(url) + "://" : "缺少 scheme://"}`;
  return null;
}

export function databasesError(dbs: Record<string, string> | undefined, override = false): string | null {
  for (const [name, url] of Object.entries(dbs ?? {})) {
    const e = dbError(name, url, override);
    if (e) return e;
  }
  return null;
}
